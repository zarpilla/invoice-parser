# Invoice Parser API

Standalone service that extracts structured JSON from PDF invoices using the
[Z.ai](https://z.ai/) (Zhipu AI / GLM) LLM.

It is the backing service for the **"Omple dades a partir de PDF"** button in
the `projectes-front` app. The Strapi backend no longer parses PDFs itself; it
proxies uploads to this service (URL + token configured in the `me` model, the
same pattern used for the `dir3` service).

## 🚀 Features

- **PDF → structured JSON**: digital PDFs are read with `pdf-parse`, then the
  text is sent to Z.ai (`glm-4.7-flash` by default) with a JSON-mode prompt.
- **Deterministic normalization**: enforces `quantity * unit_price = total`,
  fills missing per-line VAT, detects gross vs net prices, drops legal-footnote
  phantom rows and IBANs mistakenly read as tax ids.
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
  -F "file=@invoice.pdf"
```

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
    "prices_include_tax": false,
    "line_items": [
      { "description": "...", "quantity": 2, "unit_price": 50, "total": 100, "vat_rate": 21 }
    ]
  }
}
```

## 🛠️ Installation

```bash
# Install dependencies
npm install

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
# ZAI_MODEL=glm-4.7-flash
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
