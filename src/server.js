require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const ConnectPgSimple = require('connect-pg-simple');
const { pool } = require('../config/database');
const logger = require('../config/logger');

const app = express();
const PgSession = ConnectPgSimple(session);

// ── SECURITY MIDDLEWARE ───────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false, // needed for Facebook SDK
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// ── RATE LIMITING ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many attempts, please try again in 15 minutes' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Too many requests, please slow down' },
});

// ── BODY PARSING ──────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── SESSIONS (for OAuth state) ────────────────────────────
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 60 * 1000, // 30 minutes (just for OAuth flow)
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// ── STATIC FILES (uploads) ────────────────────────────────
app.use('/uploads', express.static(process.env.UPLOAD_DIR || './uploads'));

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PostPageX API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── ROUTES ────────────────────────────────────────────────
app.use('/auth',      authLimiter, require('./routes/auth'));
app.use('/facebook',  apiLimiter,  require('./routes/facebook'));
app.use('/posts',     apiLimiter,  require('./routes/posts'));
app.use('/analytics', apiLimiter,  require('./routes/analytics'));

// ── 404 HANDLER ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Don't leak stack traces in production
  const message = process.env.NODE_ENV === 'production'
    ? 'An unexpected error occurred'
    : err.message;

  res.status(err.status || 500).json({ error: message });
});

// ── START SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`PostPageX API running on port ${PORT}`, {
    env: process.env.NODE_ENV,
    frontend: process.env.FRONTEND_URL,
  });
});

module.exports = app;
