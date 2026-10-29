require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const authMiddleware = require('./middleware/auth.middleware');
const apiLimiter = require('./middleware/rateLimit.middleware');
const { handleExtract, handleStream, handleFastStream } = require('./controllers/media.controller');

const app = express();
function memoryLimitMiB(){for(const file of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes']){try{const n=Number(require('node:fs').readFileSync(file,'utf8').trim());if(Number.isFinite(n)&&n>0&&n<2**50)return Math.round(n/1048576)}catch{}}return null}

// Trust Google Cloud Run reverse proxy for accurate IP rate-limiting and HTTPS protocol detection
app.set('trust proxy', 1);

// Security & CORS Middlewares
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.use(express.json({ limit: '1mb' }));

// 1. Health Check Endpoint (Required for Cloud Run readiness probes)
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Clip Sevan Extraction Engine v2.3.1 verified MP4/MP3',
    revision: process.env.K_REVISION || null,
    memoryLimitMiB: memoryLimitMiB(),
    timestamp: new Date().toISOString()
  });
});

// 2. Metadata & Format Extraction Endpoint
app.post('/api/v1/extract', apiLimiter, authMiddleware, handleExtract);

// 3. Verified compatible MP4/MP3 delivery endpoint
app.get('/api/v1/stream', apiLimiter, handleStream);
app.get('/api/v1/fast-stream', apiLimiter, handleFastStream);

// Global 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found. Use POST /api/v1/extract or GET /api/v1/stream'
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Clip Sevan API] Server listening on http://0.0.0.0:${PORT}`);
});
