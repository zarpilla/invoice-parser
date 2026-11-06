# Invoice Parser API

Standalone service that extracts structured JSON from PDF invoices using the
[Z.ai](https://z.ai/) (Zhipu AI / GLM) LLM.

It is the backing service for the **"Omple dades a partir de PDF"** button in
the `projectes-front` app. The Strapi backend no longer parses PDFs itself; it
proxies uploads to this service (URL + token configured in the `me` model, the
same pattern used for the `dir3` service).

## 🚀 Features

- **PDF → structured JSON**: digital PDFs are read with `pdftotext -layout`
  (poppler, keeps the table columns; `pdf-parse` if poppler is missing).
  PDFs without a text layer (scans, photos) go through **GLM-OCR**. The text is
  sent to Z.ai (`glm-5.3-flash` by default) with a JSON-mode prompt that knows
  who the customer is (`customer_name` / `customer_tax_id` fields).
- **Retries**: Z.ai overload / rate-limit errors (1302, 1305, 429, 5xx) are
  retried with backoff within a 90 s budget; still failing → `503`.
- **Deterministic normalization**: enforces `quantity * unit_price = total`,
  fills only missing per-line VAT (0 % stays 0 %), detects gross vs net prices
  from the VAT total, drops legal-footnote rows, IBANs and the customer's own
  tax id, and adds `checks` (`ok` + `problems`) for the form to warn about.

### Model choice (benchmark 2026-11-06)

59 real received invoices (≈40 suppliers, 6 scans), scored on what the form
needs (supplier tax id, date, lines adding up to base + VAT):

| Pipeline | Ready | $/invoice |
|---|---|---|
| pdf-parse + glm-4.7-flash (old) | 2/28 without retries (overloaded) | free |
| pdftotext/GLM-OCR + glm-5.3-flash (now) | 57/59 | ~0.0003 |
| page images + glm-4.5v | 52/59 | ~0.0023 |
| page images + glm-5v-turbo | 51/59 | ~0.0046 |

At 14 tenants × 150 invoices/year that is well under $1/year.
- **API Token Authentication**: secure access control (`X-API-Key` header).
- **CORS Enabled**: ready for web applications.

## 📨 API

### `GET /api/health`
Public health check.

```bash
curl http://localhost:4000/api/health
```

### `POST /api/parse`
Authenticated. Upload a single PDF as `multipart/form-data` under the `file`
field. Returns the extracted invoice.

```bash
curl -X POST http://localhost:4000/api/parse \
  -H "X-API-Key: YOUR_TOKEN" \
  -F "file=@invoice.pdf" \
  -F "customer_name=La meva cooperativa SCCL" -F "customer_tax_id=F12345678"
```

`checks.problems` can hold `no_lines`, `no_total`, `lines_vs_total`,
`lines_vs_subtotal`, `no_tax_id`, `no_date`. `source` is `text` or `ocr`.

Response envelope (passed through unchanged by the Strapi proxy):

```json
{
  "success": true,
  "data": {
    "vendor_name": "...",
    "vendor_tax_id": "B73347494",
    "invoice_number": "...",
    "invoice_date": "2025-01-15",
    "due_date": "2025-02-15",
    "total_amount": 121.00,
    "subtotal": 100.00,
    "currency": "EUR",
    "vat_amount": 21.00,
    "irpf_amount": 0,
    "prices_include_tax": false,
    "line_items": [
      { "description": "...", "quantity": 2, "unit_price": 50, "total": 100, "vat_rate": 21, "irpf_rate": 0 }
    ],
    "checks": { "ok": true, "problems": [] },
    "source": "text"
  }
}
```

## 🛠️ Installation

```bash
# Install dependencies (and poppler-utils for pdftotext: apt/apk install poppler-utils)
npm install
npm test

# Copy environment file and configure
cp .env.example .env
# Edit .env and add your API tokens + ZAI_API_KEY
```

## ⚙️ Configuration (`.env`)

```env
PORT=4000
API_TOKENS=your-secret-token-1,your-secret-token-2
ZAI_API_KEY=...
# Optional overrides:
# ZAI_BASE_URL=https://api.z.ai/api/paas/v4/
# ZAI_MODEL=glm-5.3-flash
# ZAI_THINKING=low
```

Generate secure tokens with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 🐳 Docker

```bash
docker compose up -d --build
```

Health check: `GET /api/health`.

## 🔗 Wiring it into Strapi (`projectes`)

In the `projectes-front` admin (`/admin/me` → the `me` model), set:

- **`invoice_parser_api_url`** → base URL of this service (e.g. `https://invoice-parser.esstrapis.org`)
- **`invoice_parser_api_token`** → one of the `API_TOKENS` configured above

The Strapi endpoints `POST /received-invoices/upload` and
`POST /received-expenses/upload` then forward uploaded PDFs to
`${invoice_parser_api_url}/api/parse` and return this service's JSON unchanged.
