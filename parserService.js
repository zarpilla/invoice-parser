'use strict';

/**
 * invoiceParserService
 *
 * Parses PDF invoices into structured JSON using:
 *   - pdf-parse  -> extracts raw text from digital PDFs
 *   - Z.ai (Zhipu AI) -> OpenAI-compatible LLM endpoint
 *
 * The Z.ai platform exposes an OpenAI-compatible REST API, so we reuse the
 * official `openai` npm SDK simply by pointing `baseURL` at Z.ai and providing
 * the Z.ai API key through `process.env.ZAI_API_KEY`.
 *
 *   Base URL : https://api.z.ai/api/paas/v4/   (override via ZAI_BASE_URL)
 *   Model    : glm-4.7-flash                   (override via ZAI_MODEL)
 *   Docs     : https://docs.z.ai/api-reference/llm/chat-completion
 *
 * NOTE on model choice: `glm-5v-turbo` can read a PDF natively (no pdf-parse
 * needed), but it is billed separately and requires a pay-as-you-go recharge.
 * The default `glm-4.7-flash` is covered by the standard coding plan credits.
 * If you recharge and want to use a vision model, set ZAI_MODEL accordingly.
 */

// pdf-parse lazily loads a test fixture on require, which can crash inside
// some bundlers. Require it from a safe context.
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  pdfParse = null;
}

// Lazily instantiate the Z.ai OpenAI-compatible client.
// We only need one instance for the lifetime of the process.
let zaiClient = null;
function getZaiClient() {
  if (zaiClient) return zaiClient;

  const OpenAI = require('openai').default || require('openai');

  // Z.ai is OpenAI-compatible: we only change the `baseURL` and API key.
  zaiClient = new OpenAI({
    apiKey: process.env.ZAI_API_KEY || '',
    baseURL: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4/',
  });
  return zaiClient;
}

/**
 * Extract raw text from a PDF buffer using pdf-parse.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>} the extracted plain text
 */
async function extractTextFromPdf(pdfBuffer) {
  if (!pdfParse) {
    throw new Error(
      'pdf-parse is not available. Run `npm install pdf-parse` inside the invoice-parser service.'
    );
  }

  if (!pdfBuffer || !pdfBuffer.length) {
    throw new Error('The provided PDF buffer is empty.');
  }

  // pdf-parse can be invoked directly with a Buffer.
  const data = await pdfParse(pdfBuffer);
  return (data && data.text) || '';
}

/**
 * Some models wrap the payload inside a single key such as `answer`, `result`,
 * `data` or `invoice`. If the parsed object is a single-key container whose
 * value is itself an object, unwrap it so the fields stay at the top level.
 *
 * @param {object} obj
 * @returns {object}
 */
function unwrapInvoiceObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;

  const keys = Object.keys(obj);
  if (
    keys.length === 1 &&
    obj[keys[0]] &&
    typeof obj[keys[0]] === 'object' &&
    !Array.isArray(obj[keys[0]])
  ) {
    const wrapperKey = keys[0].toLowerCase();
    if (['answer', 'result', 'data', 'invoice', 'output', 'response'].includes(wrapperKey)) {
      return obj[keys[0]];
    }
  }
  return obj;
}

/**
 * Naively pull a JSON object out of a model response that may contain
 * markdown fences (```json ... ```) or surrounding prose.
 *
 * @param {string} content
 * @returns {object}
 */
function parseJsonLoose(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('The LLM did not return any content.');
  }

  let candidate = content.trim();

  // Strip markdown code fences if present.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // Last resort: grab everything between the first '{' and the last '}'.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (e2) {
        // fall through to the error below
      }
    }
    throw new Error(
      'The LLM did not return valid JSON. Raw content: ' + content.slice(0, 500)
    );
  }
}

/**
 * Parse a VAT rate value that may come as "21", "21%", "21.00%" or "21,0".
 * Returns a number or null.
 */
function parseVatRate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).replace(/%/g, '').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Spanish/foreign tax ids are short. An IBAN (or long bank-style string) is
 * not a valid tax id, so drop it when the model confused the two.
 */
function sanitizeTaxId(taxId) {
  if (!taxId) return null;
  const compact = String(taxId).replace(/\s+/g, '');
  // IBAN: 2 letters + 2 digits at the start (e.g. ES70..., FR76...).
  if (/^[A-Za-z]{2}\d{2}/.test(compact)) return null;
  return String(taxId).trim();
}

/**
 * Drop "line items" that are actually legal/registry footer text that the
 * model sometimes picks up because pdf-parse flattens the layout.
 */
const LEGAL_KEYWORDS = [
  'registro mercantil',
  'tomo ',
  'folio',
  'hoja ',
  'inscrit',
  'razon social',
];
function looksLikeLegalFooter(item) {
  const desc = String(item && item.description || '').toLowerCase();
  return LEGAL_KEYWORDS.some(k => desc.includes(k));
}

/**
 * Enforce quantity * unit_price = total when the numbers allow it. This is a
 * deterministic safety net for the cases where the model reads quantity as 1
 * but the printed total is clearly for more units.
 */
function fixLineQuantity(item) {
  const quantity = parseFloat(item.quantity);
  const unitPrice = parseFloat(item.unit_price);
  const total = parseFloat(item.total);
  let fixed = isNaN(quantity) ? 1 : quantity;

  if (!isNaN(unitPrice) && unitPrice !== 0 && !isNaN(total)) {
    const current = fixed * unitPrice;
    if (Math.abs(current - total) > 0.01) {
      const computed = total / unitPrice;
      if (computed > 0) {
        const rounded = Math.round(computed);
        fixed = Math.abs(computed - rounded) < 0.02 ? rounded : +(computed.toFixed(3));
      }
    }
  }
  return { ...item, quantity: fixed, vat_rate: parseVatRate(item.vat_rate) };
}

/**
 * Normalize the whole invoice object with deterministic corrections:
 *   - drop legal/registry phantom rows,
 *   - enforce quantity * unit_price = total,
 *   - fill missing per-line vat_rate from the document-level rate,
 *   - detect whether printed prices include tax (gross vs net),
 *   - drop tax ids that are actually IBANs.
 *
 * @param {object} invoice
 * @returns {object}
 */
function normalizeInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object') return invoice;

  let items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  items = items.filter(it => !looksLikeLegalFooter(it)).map(fixLineQuantity);

  const totalAmount = parseFloat(invoice.total_amount);
  const subtotal = parseFloat(invoice.subtotal);

  // Fill missing vat_rate from the document-level rate, when one exists.
  // Prefer the rate inferred from subtotal vs total_amount, then any rate
  // already present on the other lines.
  let docRate = null;
  if (!isNaN(subtotal) && !isNaN(totalAmount) && subtotal > 0) {
    docRate = Math.round(((totalAmount - subtotal) / subtotal) * 100);
  }
  if (docRate === null || docRate < 0) {
    const present = items
      .map(it => it.vat_rate)
      .filter(r => r !== null && !isNaN(r) && r > 0);
    if (present.length) docRate = present[0];
  }
  if (docRate !== null && !isNaN(docRate)) {
    items = items.map(it =>
      it.vat_rate === null || isNaN(it.vat_rate) || it.vat_rate === 0
        ? { ...it, vat_rate: docRate }
        : it
    );
  }

  // Detect gross vs net prices deterministically by comparing the signed sum
  // of the line totals with subtotal (net) and total_amount (gross).
  let pricesIncludeTax = invoice.prices_include_tax;
  if (items.length && !isNaN(totalAmount)) {
    const sumLines = items.reduce((s, it) => s + (Number(it.total) || 0), 0);
    if (Math.abs(sumLines - totalAmount) < 0.05) {
      pricesIncludeTax = true;
    } else if (!isNaN(subtotal) && Math.abs(sumLines - subtotal) < 0.05) {
      pricesIncludeTax = false;
    } else if (totalAmount > sumLines) {
      pricesIncludeTax = false;
    }
  }

  invoice.line_items = items;
  invoice.prices_include_tax = pricesIncludeTax;
  invoice.vendor_tax_id = sanitizeTaxId(invoice.vendor_tax_id);

  return invoice;
}

/**
 * Ask Z.ai to convert raw invoice text into strict JSON.
 *
 * @param {string} rawText
 * @returns {Promise<object>} the parsed invoice object
 */
async function extractInvoiceJsonWithLlm(rawText) {
  const client = getZaiClient();
  const model = process.env.ZAI_MODEL || 'glm-4.7-flash';

  const systemPrompt =
    'You are an invoice extraction API. Your job is to extract data from raw invoice text and return ONLY a flat JSON object with the requested fields at the top level. Do not wrap it inside another key like "answer", "result", "data" or "invoice". No markdown, no explanations.';

  const userPrompt = `Extract these fields from the invoice text: vendor_name, vendor_tax_id, invoice_number, invoice_date (YYYY-MM-DD), due_date (YYYY-MM-DD), total_amount (number: the grand total the customer pays), subtotal (number: the tax-exclusive / net base if shown), currency (ISO 4217 code, e.g. EUR), and line_items.

vendor_tax_id: the vendor NIF, CIF, DNI or VAT number. For Spain it is short, usually a letter + 8 digits (e.g. B73347494, B01730159). It is NEVER an IBAN or bank account number (an IBAN starts with 2 country letters + 2 digits, e.g. ES70...). Ignore IBAN, BIC and SWIFT codes.

line_items (each item: description, quantity, unit_price, total, vat_rate):
- ONLY include real priced product/service rows from the items table. Ignore legal notices, company-registry text (e.g. "Registro Mercantil", "Tomo", "Folio", "Hoja", "Inscrita"), payment terms and any row without a price.
- Columns named "Und", "Ud", "Unidades", "Unid", "Cant.", "Cantidad", "Qty", "Quantity" or "Units" represent the QUANTITY. Map that column to "quantity".
- Raw PDF text often loses column spacing, so numbers from adjacent cells get glued together. A price, a quantity and a total concatenated keep their column order: "11.72" + "2" + "23.44" can appear as "11.72223.44"; "20.65" + "1" + "20.65" as "20.65120.65". Use the order of the column headers to split them back into the right fields.
- unit_price and total: copy them EXACTLY as printed on the invoice (do not convert gross/net).
- vat_rate: the IVA/VAT percentage for the line (e.g. 21 for 21%). If the rate appears only once, in the tax/totals summary, that same rate applies to EVERY line item.
- CONSISTENCY RULE (very important): quantity * unit_price MUST equal total. If quantity looks like 1 but total differs from unit_price, recompute quantity = total / unit_price. Never output quantity = 1 when total is different from unit_price.

Return the fields directly at the top level of the JSON object.

INVOICE TEXT:
${rawText}`;

  // Text models support the OpenAI-style JSON mode. Forcing JSON object output
  // dramatically reduces the chance of getting markdown / prose back.
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    thinking: { type: 'disabled' },
  });

  const content =
    completion &&
    completion.choices &&
    completion.choices[0] &&
    completion.choices[0].message &&
    completion.choices[0].message.content;

  return parseJsonLoose(content);
}

/**
 * Process a PDF invoice buffer end-to-end and return structured JSON.
 *
 * Steps:
 *   A) Extract raw text from the PDF buffer (pdf-parse).
 *   B) Send the text to Z.ai with a JSON-mode prompt.
 *   C) Parse and return the resulting JSON object.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<object>}
 */
async function processInvoicePdf(pdfBuffer) {
  // Step A: extract text from the digital PDF.
  const rawText = await extractTextFromPdf(pdfBuffer);

  if (!rawText || !rawText.trim()) {
    throw new Error(
      'No text could be extracted from the PDF. It may be a scanned image (OCR is required) or an empty file.'
    );
  }

  // Step B + C: ask the LLM for structured JSON, parse and normalize it.
  const invoice = await extractInvoiceJsonWithLlm(rawText);

  return normalizeInvoice(unwrapInvoiceObject(invoice));
}

module.exports = {
  processInvoicePdf,
  extractTextFromPdf,
  extractInvoiceJsonWithLlm,
};
