'use strict';
// Cases taken from the 2026-11-06 benchmark on real received invoices.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../parserService');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} != ${b}`);

test('EU VAT ids are kept, IBANs dropped (was: every "2 letters + 2 digits" id dropped)', () => {
  for (const id of ['IE4276970QH', 'DE267602842', 'LU20260743', 'CY10301365E', 'CHE-459.847.656', 'B73347494']) {
    assert.equal(p.sanitizeTaxId(id), id);
  }
  assert.equal(p.sanitizeTaxId('ES91 2100 0418 4502 0005 1332'), null);
  assert.equal(p.sanitizeTaxId('ES7000491500051234567892'), null);
});

test("the customer's own tax id is never the vendor", () => {
  assert.equal(p.sanitizeTaxId('39891236J', '39891236J'), null);
  assert.equal(p.sanitizeTaxId('ES39891236J', '39891236J'), null);
  assert.equal(p.sanitizeTaxId('B73347494', '39891236J'), 'B73347494');
});

test('an explicit 0 % line keeps 0 % (PcComponentes: 1 EUR at 0 % + 259.12 at 21 %)', () => {
  const inv = p.normalizeInvoice({
    vendor_tax_id: 'B73347494', invoice_date: '2024-12-19',
    subtotal: 260.12, vat_amount: 54.42, total_amount: 314.54,
    line_items: [
      { description: 'Portes', quantity: 1, unit_price: 1, total: 1, vat_rate: 0 },
      { description: 'Monitor', quantity: 1, unit_price: 259.12, total: 259.12, vat_rate: 21 },
    ],
  });
  const t = p.lineTotals(inv);
  near(t.net, 260.12, 'net');
  near(t.vat, 54.42, 'vat');
  assert.equal(inv.checks.ok, true);
});

test('missing line rates are filled from the totals', () => {
  const inv = p.normalizeInvoice({ subtotal: 100, vat_amount: 21, total_amount: 121, line_items: [{ description: 'x', quantity: 1, unit_price: 100, total: 100 }] });
  assert.equal(inv.line_items[0].vat_rate, 21);
});

test('VAT-included prices with a gross "Subtotal" (Tutao: 24,00 incl. 4,17 VAT)', () => {
  const inv = p.normalizeInvoice({
    subtotal: 24, vat_amount: 4.17, total_amount: 24,
    line_items: [{ description: 'Premium', quantity: 1, unit_price: 24, total: 24, vat_rate: 21 }],
  });
  assert.equal(inv.prices_include_tax, true);
  const t = p.lineTotals(inv);
  near(t.net, 19.83, 'net');
  near(t.vat, 4.17, 'vat');
});

test('lines read at 0 % on an invoice that charges VAT get the printed rate (Codection)', () => {
  const inv = p.normalizeInvoice({
    vat_amount: 6.27, total_amount: 36.11,
    line_items: [
      { description: 'RedSys Gateway', quantity: 1, unit_price: 34.95, total: 34.95, vat_rate: 0 },
      { description: 'Comisión de PayPal', quantity: 1, unit_price: 1.16, total: 1.16, vat_rate: 0 },
    ],
  });
  assert.equal(inv.prices_include_tax, true);
  assert.deepEqual(inv.line_items.map((l) => l.vat_rate), [21, 21]);
  near(p.lineTotals(inv).net, 29.84, 'net');
});

test('discounted unit price keeps 4 decimals so the lines add up (Proton: 16 x 37.49 = 599.91)', () => {
  const inv = p.normalizeInvoice({
    subtotal: 637.4, vat_amount: 0, total_amount: 637.4,
    line_items: [
      { description: 'Mail Essentials', quantity: 1, unit_price: 37.49, total: 37.49, vat_rate: 0 },
      { description: 'Mail Essentials +1 User', quantity: 16, unit_price: 37.49, total: 599.91, vat_rate: 0 },
    ],
  });
  assert.equal(inv.line_items[1].quantity, 16);
  assert.equal(inv.line_items[1].unit_price, 37.4944);
  near(p.lineTotals(inv).net, 637.4, 'net');
});

test('the quantity is recomputed when the model reads 1 for several units', () => {
  const inv = p.normalizeInvoice({ total_amount: 23.44, line_items: [{ description: 'x', quantity: 1, unit_price: 11.72, total: 23.44, vat_rate: 0 }] });
  assert.equal(inv.line_items[0].quantity, 2);
  assert.equal(inv.line_items[0].unit_price, 11.72);
});

test('IRPF: net lines, VAT and retention add up to the printed total', () => {
  const inv = p.normalizeInvoice({
    vendor_tax_id: '39891236J', invoice_date: '2026-10-26',
    subtotal: 1975, vat_amount: 414.75, irpf_amount: 296.25, total_amount: 2093.5,
    line_items: [{ description: 'Eines digitals', quantity: 1, unit_price: 1975, total: 1975, vat_rate: 21, irpf_rate: 15 }],
  });
  assert.equal(inv.prices_include_tax, false);
  near(p.lineTotals(inv).irpf, 296.25, 'irpf');
  assert.deepEqual(inv.checks, { ok: true, problems: [] });
});

test('checks flag lines that do not add up and missing fields', () => {
  const inv = p.normalizeInvoice({ total_amount: 100, subtotal: 50, vat_amount: 10, line_items: [{ description: 'x', quantity: 1, unit_price: 50, total: 50, vat_rate: 21 }] });
  assert.equal(inv.checks.ok, false);
  assert.ok(inv.checks.problems.includes('lines_vs_total'));
  assert.ok(inv.checks.problems.includes('no_tax_id'));
  assert.ok(inv.checks.problems.includes('no_date'));
});

test('legal footer rows are dropped', () => {
  const inv = p.normalizeInvoice({ line_items: [{ description: 'Inscrita en el Registro Mercantil, Tomo 1', total: 0 }, { description: 'x', quantity: 1, unit_price: 1, total: 1, vat_rate: 0 }] });
  assert.equal(inv.line_items.length, 1);
});

test('the prompt names the customer and says dates are day first', () => {
  const s = p.buildUserPrompt('TEXT', { customerName: 'Arran de terra SCCL', customerTaxId: 'F67427690' });
  assert.match(s, /THE CUSTOMER .*"Arran de terra SCCL" with tax id F67427690/);
  assert.match(s, /"03\/09\/2024" .* = 2024-09-03/);
  assert.ok(s.endsWith('INVOICE TEXT:\nTEXT'));
  assert.doesNotMatch(p.buildUserPrompt('TEXT'), /THE CUSTOMER/);
});

test('glm-5.3 models think at low effort; older flash models disable thinking', () => {
  const prev = process.env.ZAI_THINKING;
  delete process.env.ZAI_THINKING;
  assert.deepEqual([p.chatBody('glm-5.3-flash', 'x').thinking, p.chatBody('glm-5.3-flash', 'x').reasoning_effort], [{ type: 'enabled' }, 'low']);
  assert.deepEqual(p.chatBody('glm-4.7-flash', 'x').thinking, { type: 'disabled' });
  process.env.ZAI_THINKING = 'high';
  assert.equal(p.chatBody('glm-5.3-flash', 'x').reasoning_effort, 'high');
  if (prev === undefined) delete process.env.ZAI_THINKING; else process.env.ZAI_THINKING = prev;
});

test('overload / rate-limit errors are retried, other errors are not', async () => {
  const sleep = async () => {};
  let n = 0;
  const r = await p.withRetry(async () => {
    if (++n < 3) throw Object.assign(new Error('overloaded'), { code: '1305' });
    return 'ok';
  }, { sleep });
  assert.equal(r, 'ok');
  assert.equal(n, 3);

  n = 0;
  await assert.rejects(p.withRetry(async () => { n++; throw Object.assign(new Error('bad param'), { code: '1210', status: 400 }); }, { sleep }), /bad param/);
  assert.equal(n, 1);

  n = 0;
  await assert.rejects(p.withRetry(async () => { n++; throw Object.assign(new Error('busy'), { status: 429 }); }, { sleep, deadline: Date.now() + 10, baseDelayMs: 1000 }), /busy/);
  assert.equal(n, 1, 'no retry past the deadline');
});

function fakeZai(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const endpoint = url.split('/').pop();
    return { ok: true, status: 200, json: async () => handlers[endpoint](body) };
  };
  return { fetchImpl, calls };
}

const chatReply = (obj) => () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

test('a scan (no text layer) goes through GLM-OCR, and the customer id is dropped', async () => {
  const { fetchImpl, calls } = fakeZai({
    layout_parsing: () => ({ md_results: 'ARSOPELL REUS, S.L. - B-55674493 ... TOTAL FACTURA : 195,00' }),
    'completions': chatReply({
      vendor_name: 'ARSOPELL REUS', vendor_tax_id: '39891236J', invoice_date: '2023-03-18',
      subtotal: 161.16, vat_amount: 33.84, total_amount: 195,
      line_items: [{ description: 'Motxilles', quantity: 1, unit_price: 195, total: 195, vat_rate: 21 }],
    }),
  });
  const inv = await p.processInvoicePdf(Buffer.from('%PDF-1.4'), { fetchImpl, pdftotext: async () => '  \n\f', customerName: 'Jordi', customerTaxId: '39891236J' });
  assert.equal(inv.source, 'ocr');
  assert.equal(calls[0].body.model, 'glm-ocr');
  assert.match(calls[1].body.messages[1].content, /ARSOPELL REUS/);
  assert.match(calls[1].body.messages[1].content, /with tax id 39891236J/);
  assert.equal(inv.vendor_tax_id, null);
  assert.equal(inv.prices_include_tax, true);
  near(p.lineTotals(inv).net, 161.16, 'net');
});

test('a digital PDF uses its text and skips OCR', async () => {
  const { fetchImpl, calls } = fakeZai({
    'completions': chatReply({ invoice: { vendor_tax_id: 'B62844725', invoice_date: '2025-10-05', subtotal: 21.05, vat_amount: 4.42, total_amount: 25.47, line_items: [{ description: 'Hosting', quantity: 1, unit_price: 21.05, total: 21.05, vat_rate: 21 }] } }),
  });
  const text = 'cdmon  CIF B62844725  Hosting 21,05 ... Total 25,47';
  const inv = await p.processInvoicePdf(Buffer.from('%PDF-1.4'), { fetchImpl, pdftotext: async () => text });
  assert.equal(calls.length, 1);
  assert.equal(inv.source, 'text');
  assert.ok(calls[0].body.messages[1].content.endsWith(text));
});
