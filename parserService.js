'use strict';

/**
 * invoiceParserService
 *
 * PDF invoice -> structured JSON:
 *   1. text:  `pdftotext -layout` (poppler) keeps the columns of the items
 *             table; pdf-parse is the fallback when poppler is not installed.
 *   2. OCR:   when the PDF has no text layer (scan, photo), GLM-OCR
 *             (`layout_parsing`) turns it into Markdown.
 *   3. LLM:   the text goes to a Z.ai chat model in JSON mode
 *             (glm-5.3-flash by default; ZAI_MODEL overrides it).
 *   4. normalizeInvoice(): deterministic fixes + consistency checks.
 *
 * The model choice comes from a benchmark on 59 real received invoices
 * (2026-11-06): pdftotext + GLM-OCR fallback + glm-5.3-flash got 57/59 ready
 * to save at ~$0.0003 per invoice; the free glm-4.7-flash was overloaded on
 * most requests and vision models (glm-4.5v, glm-5v-turbo) were not better.
 *
 *   Base URL : https://api.z.ai/api/paas/v4/   (override via ZAI_BASE_URL)
 *   Docs     : https://docs.z.ai/api-reference/llm/chat-completion
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  pdfParse = null;
}

const DEFAULT_MODEL = 'glm-5.3-flash';
const DEADLINE_MS = Number(process.env.PARSE_DEADLINE_MS) || 90000; // the Strapi proxy waits 120 s
const MIN_TEXT_CHARS = 30; // below this the PDF is treated as a scan

const baseUrl = () => {
  const b = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4/';
  return b.endsWith('/') ? b : b + '/';
};

// ---------------------------------------------------------------- Z.ai calls

class ZaiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// 1302 rate limit, 1305 overloaded: the free / flash tiers return them often.
const TRANSIENT_CODES = ['1302', '1303', '1305'];
function isTransient(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (TRANSIENT_CODES.includes(String(err.code))) return true;
  return [429, 500, 502, 503, 504].includes(err.status);
}

async function zaiPost(endpoint, body, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const res = await fetchImpl(baseUrl() + endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZAI_API_KEY || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    json = null;
  }
  if (!res.ok || !json || json.error) {
    const e = (json && json.error) || {};
    throw new ZaiError(e.message || `Z.ai HTTP ${res.status}`, e.code, res.status);
  }
  return json;
}

/**
 * Retry overload / rate-limit errors with backoff, within the request deadline.
 */
async function withRetry(fn, { deadline, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), baseDelayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = baseDelayMs * 2 ** attempt;
      if (!isTransient(err) || attempt >= 4 || (deadline && Date.now() + delay > deadline)) throw err;
      await sleep(delay);
    }
  }
}

// ------------------------------------------------------------------ text/OCR

function runPdftotext(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `invoice-${crypto.randomBytes(8).toString('hex')}.pdf`);
    fs.writeFileSync(file, pdfBuffer, { mode: 0o600 });
    execFile('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 20 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      fs.unlink(file, () => {});
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Text of a digital PDF, keeping the layout when poppler is available.
 * @returns {Promise<string>}
 */
async function extractTextFromPdf(pdfBuffer, { pdftotext = runPdftotext } = {}) {
  if (!pdfBuffer || !pdfBuffer.length) {
    throw new Error('The provided PDF buffer is empty.');
  }
  try {
    return await pdftotext(pdfBuffer);
  } catch (e) {
    if (!pdfParse) throw new Error('Neither pdftotext (poppler-utils) nor pdf-parse is available.');
    const data = await pdfParse(pdfBuffer);
    return (data && data.text) || '';
  }
}

/**
 * GLM-OCR (`layout_parsing`): scanned PDF -> Markdown (tables as HTML).
 */
async function ocrPdf(pdfBuffer, { fetchImpl, deadline } = {}) {
  const json = await withRetry(
    () => zaiPost('layout_parsing', { model: 'glm-ocr', file: 'data:application/pdf;base64,' + pdfBuffer.toString('base64') }, { fetchImpl, timeoutMs: 60000 }),
    { deadline }
  );
  return json.md_results || '';
}

// -------------------------------------------------------------------- prompt

const SYSTEM_PROMPT =
  'You are an invoice extraction API. Extract data from a supplier invoice and return ONLY a flat JSON object with the requested fields at the top level. Do not wrap it inside another key like "answer", "result", "data" or "invoice". No markdown, no explanations.';

function buildUserPrompt(rawText, { customerName, customerTaxId } = {}) {
  const customer =
    customerName || customerTaxId
      ? `\nTHE CUSTOMER (who received this invoice) is "${customerName || ''}"${customerTaxId ? ` with tax id ${customerTaxId}` : ''}. The vendor is the OTHER party, the one who issued the invoice. Never return the customer's name or tax id as the vendor.\n`
      : '';
  return `Extract these fields from the invoice: vendor_name, vendor_tax_id, invoice_number, invoice_date (YYYY-MM-DD), due_date (YYYY-MM-DD or null), currency (ISO 4217, e.g. EUR, USD), subtotal (number: total tax base, after discounts), vat_amount (number: total VAT/IVA), irpf_amount (number: total IRPF/withholding retained, positive, 0 if none), total_amount (number: the grand total printed on the invoice, after VAT and after IRPF), prices_include_tax (true if the line prices printed already include VAT), and line_items.
${customer}
vendor_tax_id: the vendor NIF, CIF, DNI or VAT number exactly as printed, keeping any country prefix (e.g. B73347494, IE4276970QH, DE267602842, CHE-459.847.656). It is NEVER an IBAN, bank account, phone number or the customer's tax id. If the vendor's tax id is not printed, return null.

invoice_number: the invoice number as printed (not the order number, customer id or page number, unless no invoice number exists).

Dates: invoices from Spain and Europe write dates day first. "03/09/2024" and "03-09-2024" are 3 September 2024 = 2024-09-03. "21.3.2025" = 2025-03-21. Only vendors from the USA write month first ("01/07/25" on a US invoice = 2025-01-07).

line_items (each item: description, quantity, unit_price, total, vat_rate, irpf_rate):
- ONLY real priced product/service rows. Ignore legal notices, company-registry text (e.g. "Registro Mercantil", "Tomo", "Folio", "Hoja", "Inscrita"), payment terms, bank data and rows without a price. Fees or shipping charged on the invoice ARE lines.
- Columns named "Und", "Ud", "Unidades", "Cant.", "Cantidad", "Qty", "Quantity" or "Units" are the QUANTITY.
- If a line or the whole invoice has a DISCOUNT, unit_price must be the price per unit AFTER the discount, so that quantity * unit_price = the discounted line total. A document-level discount is spread over the lines (or added as a negative line).
- unit_price and total: as printed (after discount); do not convert gross/net yourself, set prices_include_tax instead.
- vat_rate: the VAT/IVA % of the line (21, 10, 4, 0...). If the rate appears only once in the totals, it applies to every line. Use 0 for exempt, reverse-charge or non-Spanish-VAT lines with no VAT charged.
- irpf_rate: the IRPF retention % applied to the line (e.g. 15 or 7), 0 if none.
- quantity * unit_price MUST equal total.

Return the fields directly at the top level of the JSON object.

INVOICE TEXT:
${rawText}`;
}

// ------------------------------------------------------------ JSON handling

function unwrapInvoiceObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const keys = Object.keys(obj);
  if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === 'object' && !Array.isArray(obj[keys[0]])) {
    if (['answer', 'result', 'data', 'invoice', 'output', 'response'].includes(keys[0].toLowerCase())) return obj[keys[0]];
  }
  return obj;
}

function parseJsonLoose(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('The LLM did not return any content.');
  }
  let candidate = content.trim();
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidate = fenceMatch[1].trim();
  try {
    return JSON.parse(candidate);
  } catch (e) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (e2) {
        // fall through
      }
    }
    throw new Error('The LLM did not return valid JSON. Raw content: ' + content.slice(0, 500));
  }
}

// ------------------------------------------------------------- normalisation

const num = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(/%/g, '').replace(',', '.'));
};

const compactId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Keep real tax ids (EU VAT ids like IE4276970QH start with 2 letters + digits
 * too); drop IBANs (15-34 chars) and the customer's own tax id.
 */
function sanitizeTaxId(taxId, customerTaxId) {
  if (!taxId) return null;
  const compact = compactId(taxId);
  if (!compact) return null;
  if (compact.length >= 15 && /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return null;
  const c = compactId(customerTaxId);
  if (c && (compact === c || compact.endsWith(c))) return null;
  return String(taxId).trim();
}

const LEGAL_KEYWORDS = ['registro mercantil', 'tomo ', 'folio', 'hoja ', 'inscrit', 'razon social'];
const looksLikeLegalFooter = (item) => LEGAL_KEYWORDS.some((k) => String((item && item.description) || '').toLowerCase().includes(k));

/**
 * quantity * unit_price = total: recompute the quantity when the model read 1
 * for several units, then keep a 4-decimal unit price when rounding (e.g. a
 * discounted price) still leaves a gap.
 */
function fixLine(item) {
  let q = num(item.quantity);
  if (isNaN(q) || q === 0) q = 1;
  const up = num(item.unit_price);
  const tot = num(item.total);
  if (!isNaN(up) && up !== 0 && !isNaN(tot) && Math.abs(q * up - tot) > 0.01) {
    const c = tot / up;
    if (c > 0) q = Math.abs(c - Math.round(c)) < 0.02 ? Math.round(c) : +c.toFixed(3);
  }
  let unit = up;
  if (!isNaN(up) && !isNaN(tot) && q > 0 && Math.abs(q * up - tot) > 0.005) unit = +(tot / q).toFixed(4);
  const vat = num(item.vat_rate);
  const irpf = num(item.irpf_rate);
  return {
    ...item,
    quantity: q,
    unit_price: isNaN(unit) ? item.unit_price : unit,
    vat_rate: isNaN(vat) ? null : vat,
    irpf_rate: isNaN(irpf) ? 0 : Math.abs(irpf),
  };
}

/** What the ESSTrapis form computes from the lines (net, VAT, IRPF). */
function lineTotals(invoice) {
  let net = 0;
  let vat = 0;
  let irpf = 0;
  for (const it of invoice.line_items || []) {
    let up = num(it.unit_price) || 0;
    const v = num(it.vat_rate) || 0;
    if (invoice.prices_include_tax && v > 0) up /= 1 + v / 100;
    const q = num(it.quantity) || 1;
    net += q * up;
    vat += (q * up * v) / 100;
    irpf += (q * up * (num(it.irpf_rate) || 0)) / 100;
  }
  return { net, vat, irpf };
}

/**
 * Problems a person should look at before saving. `ok` = the lines add up to
 * the printed total and the main fields are there.
 */
function consistencyChecks(invoice) {
  const { net, vat, irpf } = lineTotals(invoice);
  const total = num(invoice.total_amount);
  const subtotal = num(invoice.subtotal);
  const tol = (x) => Math.max(0.03, 0.002 * Math.abs(x));
  const problems = [];
  if (!(invoice.line_items || []).length) problems.push('no_lines');
  if (isNaN(total)) problems.push('no_total');
  else if (Math.abs(net + vat - irpf - total) > tol(total)) problems.push('lines_vs_total');
  if (!invoice.prices_include_tax && !isNaN(subtotal) && Math.abs(net - subtotal) > tol(subtotal)) problems.push('lines_vs_subtotal');
  if (!invoice.vendor_tax_id) problems.push('no_tax_id');
  if (!invoice.invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(invoice.invoice_date)) problems.push('no_date');
  return { ok: problems.length === 0, problems };
}

/**
 * Deterministic corrections over the model output:
 *   - drop legal/registry phantom rows,
 *   - quantity * unit_price = total,
 *   - fill only MISSING VAT rates (an explicit 0 % stays: exempt lines are real),
 *   - gross vs net from the VAT total (net + VAT - IRPF = total),
 *   - drop IBANs and the customer's own tax id,
 *   - add `checks` for the form.
 */
function normalizeInvoice(invoice, { customerTaxId } = {}) {
  if (!invoice || typeof invoice !== 'object') return invoice;

  let items = (Array.isArray(invoice.line_items) ? invoice.line_items : []).filter((it) => !looksLikeLegalFooter(it)).map(fixLine);

  const total = num(invoice.total_amount);
  const subtotal = num(invoice.subtotal);
  const vatAmount = num(invoice.vat_amount);
  const irpf = Math.abs(num(invoice.irpf_amount)) || 0;

  let docRate = null;
  if (!isNaN(subtotal) && subtotal > 0 && !isNaN(vatAmount)) docRate = Math.round((vatAmount / subtotal) * 100);
  else if (!isNaN(subtotal) && subtotal > 0 && !isNaN(total)) docRate = Math.round(((total + irpf - subtotal) / subtotal) * 100);
  if (docRate !== null && docRate >= 0) items = items.map((it) => (it.vat_rate === null ? { ...it, vat_rate: docRate } : it));
  items = items.map((it) => (it.vat_rate === null ? { ...it, vat_rate: 0 } : it));

  let pricesIncludeTax = invoice.prices_include_tax === true;
  if (items.length && !isNaN(total)) {
    const sum = items.reduce((s, it) => s + (num(it.total) || 0), 0);
    const close = (a, b) => Math.abs(a - b) <= Math.max(0.03, 0.002 * Math.abs(b));
    const hasVat = !isNaN(vatAmount) && vatAmount > 0;
    if (hasVat && close(sum + vatAmount - irpf, total)) pricesIncludeTax = false;
    else if (hasVat && close(sum - irpf, total)) pricesIncludeTax = true;
    else if (!isNaN(subtotal) && close(sum, subtotal) && !close(subtotal, total + irpf)) pricesIncludeTax = false;
    // lines all at 0 % but the invoice charges VAT: the rate printed once applies to every line
    if (hasVat && items.every((it) => !it.vat_rate)) {
      const base = pricesIncludeTax ? total + irpf - vatAmount : sum;
      const rate = base > 0 ? Math.round((vatAmount / base) * 100) : null;
      if (rate) items = items.map((it) => ({ ...it, vat_rate: rate }));
    }
  }

  invoice.line_items = items;
  invoice.prices_include_tax = pricesIncludeTax;
  invoice.vendor_tax_id = sanitizeTaxId(invoice.vendor_tax_id, customerTaxId);
  invoice.checks = consistencyChecks(invoice);
  return invoice;
}

// ----------------------------------------------------------------------- LLM

function chatBody(model, prompt) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  };
  // glm-5.3-flash always thinks (low/high/max); older flash models take "disabled".
  const effort = process.env.ZAI_THINKING || (model.startsWith('glm-5.3') ? 'low' : 'disabled');
  if (effort === 'disabled') body.thinking = { type: 'disabled' };
  else {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = effort;
  }
  return body;
}

async function extractInvoiceJsonWithLlm(rawText, opts = {}) {
  const model = process.env.ZAI_MODEL || DEFAULT_MODEL;
  const json = await withRetry(
    () => zaiPost('chat/completions', chatBody(model, buildUserPrompt(rawText, opts)), { fetchImpl: opts.fetchImpl, timeoutMs: 60000 }),
    { deadline: opts.deadline }
  );
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  return parseJsonLoose(content);
}

/**
 * PDF buffer -> invoice JSON.
 * @param {Buffer} pdfBuffer
 * @param {{customerName?: string, customerTaxId?: string}} opts  the tenant receiving the invoice
 */
async function processInvoicePdf(pdfBuffer, opts = {}) {
  const deadline = Date.now() + DEADLINE_MS;
  const o = { ...opts, deadline };

  let text = await extractTextFromPdf(pdfBuffer, o);
  let source = 'text';
  if (String(text || '').replace(/\s/g, '').length < MIN_TEXT_CHARS) {
    text = await ocrPdf(pdfBuffer, o);
    source = 'ocr';
  }
  if (!text || !text.trim()) {
    throw new Error('No text could be read from the PDF, not even with OCR. It may be empty or unreadable.');
  }

  const invoice = await extractInvoiceJsonWithLlm(text, o);
  const result = normalizeInvoice(unwrapInvoiceObject(invoice), { customerTaxId: opts.customerTaxId });
  result.source = source;
  return result;
}

module.exports = {
  processInvoicePdf,
  extractTextFromPdf,
  extractInvoiceJsonWithLlm,
  normalizeInvoice,
  sanitizeTaxId,
  consistencyChecks,
  lineTotals,
  buildUserPrompt,
  chatBody,
  withRetry,
  isTransient,
  parseJsonLoose,
  unwrapInvoiceObject,
};
