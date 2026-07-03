const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const { processInvoicePdf } = require('./parserService');

const app = express();
const PORT = process.env.PORT || 4000;

// In-memory uploads (no disk). PDFs are parsed straight from the buffer.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // 25 MB matches the nginx client_max_body_size and is plenty for a PDF.
    fileSize: 25 * 1024 * 1024,
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// API Token Authentication Middleware
const authenticate = (req, res, next) => {
  const token = req.headers['x-api-key'] || req.query.apiKey;

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required. Provide it via X-API-Key header or apiKey query parameter.'
    });
  }

  const validTokens = process.env.API_TOKENS ?
    process.env.API_TOKENS.split(',').map(t => t.trim()) : [];

  if (!validTokens.includes(token)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key.'
    });
  }

  next();
};

// Public health endpoint - no authentication required
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Invoice Parser API',
    version: '1.0.0',
    zaiConfigured: Boolean(process.env.ZAI_API_KEY),
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/parse
 *
 * Accepts a single PDF upload (multipart/form-data, field `file`) and returns
 * the structured invoice JSON extracted by the Z.ai LLM pipeline.
 */
app.post('/api/parse', authenticate, upload.single('file'), async (req, res) => {
  try {
    const pdfBuffer = req.file && req.file.buffer;

    if (!pdfBuffer || !pdfBuffer.length) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No PDF file was provided. Upload it as multipart/form-data under the `file` field.'
      });
    }

    const invoice = await processInvoicePdf(pdfBuffer);

    return res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Error parsing invoice PDF:', error);

    // pdf-parse / LLM errors are user-facing (bad PDF, no text, bad JSON).
    const message = error && error.message ? error.message : 'Failed to process the invoice PDF.';
    return res.status(400).json({
      error: 'Bad Request',
      message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'Endpoint not found',
    availableEndpoints: [
      'GET /api/health',
      'POST /api/parse'
    ]
  });
});

// Error handler (e.g. multer file-size limits)
app.use((err, req, res, next) => {
  console.error('Error:', err);

  // multer throws this when the uploaded file exceeds the configured limit.
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'The uploaded PDF exceeds the maximum allowed size.'
    });
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// Start server
function start() {
  if (!process.env.API_TOKENS) {
    console.error('❌ No API_TOKENS configured. Refusing to start.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🌐 Invoice Parser API running on http://localhost:${PORT}`);
    console.log(`🔑 Authentication: Enabled`);
    console.log(`🤖 Z.ai LLM: ${process.env.ZAI_API_KEY ? 'Configured' : 'WARNING - No ZAI_API_KEY set!'}`);
    console.log(`\nTest it: curl -H "X-API-Key: YOUR_TOKEN" http://localhost:${PORT}/api/health`);
  });
}

start();
