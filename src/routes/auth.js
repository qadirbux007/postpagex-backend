const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { body, validationResult } = require('express-validator');
const { query } = require('../../config/database');
const { generateToken, setTokenCookie } = require('../middleware/auth');
const logger = require('../../config/logger');

// ── PASSPORT: GOOGLE STRATEGY ───────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const googleId = profile.id;
    const name = profile.displayName;
    const avatarUrl = profile.photos?.[0]?.value;

    // Check if user already exists
    let result = await query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [googleId, email]);

    if (result.rows.length > 0) {
      // Update existing user
      const user = result.rows[0];
      await query(
        'UPDATE users SET google_id=$1, name=$2, avatar_url=$3, last_login_at=NOW() WHERE id=$4',
        [googleId, name, avatarUrl, user.id]
      );
      return done(null, user);
    }

    // Create new user
    const newUser = await query(
      `INSERT INTO users (email, name, avatar_url, google_id, email_verified)
       VALUES ($1, $2, $3, $4, true) RETURNING *`,
      [email, name, avatarUrl, googleId]
    );

    logger.info('New user registered via Google', { email });
    return done(null, newUser.rows[0]);
  } catch (err) {
    logger.error('Google OAuth error', { error: err.message });
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0] || null);
  } catch (err) {
    done(err);
  }
});

// ── GOOGLE OAUTH ─────────────────────────────────────────

// Step 1: Redirect to Google
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Step 2: Google redirects back here
router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=google_failed' }),
  (req, res) => {
    const token = generateToken(req.user.id);
    setTokenCookie(res, token);
    // Redirect to dashboard
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?auth=success`);
  }
);

// ── EMAIL / PASSWORD SIGNUP ──────────────────────────────

router.post('/signup', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, email, password } = req.body;

  try {
    // Check if email already taken
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name`,
      [email, name, passwordHash]
    );

    const user = result.rows[0];
    const token = generateToken(user.id);
    setTokenCookie(res, token);

    logger.info('New user registered via email', { email });
    res.status(201).json({ message: 'Account created', user: { id: user.id, email: user.email, name: user.name }, token });
  } catch (err) {
    logger.error('Signup error', { error: err.message });
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// ── EMAIL / PASSWORD LOGIN ───────────────────────────────

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  const { email, password } = req.body;

  try {
    const result = await query(
      'SELECT id, email, name, avatar_url, password_hash, is_active FROM users WHERE email = $1',
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account has been deactivated' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses Google sign-in. Please log in with Google.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = generateToken(user.id);
    setTokenCookie(res, token);

    logger.info('User logged in', { email });
    res.json({
      message: 'Logged in successfully',
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
      token,
    });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// ── LOGOUT ───────────────────────────────────────────────

router.post('/logout', (req, res) => {
  res.clearCookie('ppx_token');
  res.json({ message: 'Logged out successfully' });
});

// ── GET CURRENT USER ─────────────────────────────────────

router.get('/me', require('../middleware/auth').requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
