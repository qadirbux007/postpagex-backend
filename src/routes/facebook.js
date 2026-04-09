const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../middleware/auth');
const fb = require('../services/facebook');
const { query } = require('../../config/database');
const { decrypt } = require('../utils/encryption');
const logger = require('../../config/logger');

// ── STEP 1: Start Facebook OAuth ─────────────────────────
// Frontend calls this to get the redirect URL
router.get('/connect', requireAuth, (req, res) => {
  // Encode userId + random nonce directly in the state JWT
  // No session needed — the state is self-contained and signed
  const state = jwt.sign(
    {
      userId: req.user.id,
      nonce: crypto.randomBytes(16).toString('hex'),
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const oauthUrl = fb.getOAuthUrl(state);
  res.json({ url: oauthUrl });
});

// ── STEP 2: Facebook redirects back here ─────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logger.warn('Facebook OAuth denied by user', { error });
    return res.redirect(
      `${process.env.FRONTEND_URL}/dashboard.html?fb_error=denied`
    );
  }

  if (!state) {
    logger.warn('Facebook OAuth missing state parameter');
    return res.redirect(
      `${process.env.FRONTEND_URL}/dashboard.html?fb_error=state_mismatch`
    );
  }

  // Verify state JWT — no session needed
  let decoded;
  try {
    decoded = jwt.verify(state, process.env.JWT_SECRET);
  } catch (jwtErr) {
    logger.warn('Facebook OAuth invalid or expired state JWT', {
      error: jwtErr.message,
    });
    return res.redirect(
      `${process.env.FRONTEND_URL}/dashboard.html?fb_error=state_mismatch`
    );
  }

  const userId = decoded.userId;
  if (!userId) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/login.html?error=session_expired`
    );
  }

  try {
    // Exchange code for short-lived token
    const tokenData = await fb.exchangeCodeForToken(code);

    // Extend to long-lived token (60 days)
    const longTokenData = await fb.extendToken(tokenData.access_token);

    // Save to DB (encrypts tokens automatically)
    const { pages } = await fb.saveConnection(
      userId,
      tokenData.access_token,
      longTokenData.access_token,
      longTokenData.expires_in
    );

    logger.info('Facebook connected successfully', {
      userId,
      pages: pages.length,
    });

    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard.html?fb_connected=${pages.length}`
    );
  } catch (err) {
    logger.error('Facebook OAuth callback error', { error: err.message });
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard.html?fb_error=connection_failed`
    );
  }
});

// ── GET CONNECTED PAGES ───────────────────────────────────
router.get('/pages', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, page_id, page_name, page_category, page_picture_url,
              page_fan_count, is_active, color, connected_at, last_synced_at
       FROM facebook_pages
       WHERE user_id = $1 AND is_active = true
       ORDER BY page_name ASC`,
      [req.user.id]
    );
    res.json({ pages: result.rows });
  } catch (err) {
    logger.error('Get pages error', { error: err.message });
    res.status(500).json({ error: 'Could not fetch pages' });
  }
});

// ── DISCONNECT A PAGE ─────────────────────────────────────
router.delete('/pages/:pageId', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'UPDATE facebook_pages SET is_active = false WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.pageId, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Page not found' });
    }
    res.json({ message: 'Page disconnected successfully' });
  } catch (err) {
    logger.error('Disconnect page error', { error: err.message });
    res.status(500).json({ error: 'Could not disconnect page' });
  }
});

// ── UPDATE PAGE COLOR ─────────────────────────────────────
router.patch('/pages/:pageId/color', requireAuth, async (req, res) => {
  const { color } = req.body;
  if (!color || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return res.status(400).json({ error: 'Invalid color format' });
  }
  try {
    await query(
      'UPDATE facebook_pages SET color = $1 WHERE id = $2 AND user_id = $3',
      [color, req.params.pageId, req.user.id]
    );
    res.json({ message: 'Color updated' });
  } catch (err) {
    res.status(500).json({ error: 'Could not update color' });
  }
});

// ── CHECK TOKEN HEALTH ────────────────────────────────────
router.get('/pages/:pageId/token-health', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT page_token_enc, page_token_expires_at FROM facebook_pages WHERE id = $1 AND user_id = $2',
      [req.params.pageId, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Page not found' });
    }
    const page = result.rows[0];
    const token = decrypt(page.page_token_enc);
    const tokenInfo = await fb.debugToken(token);
    res.json({
      is_valid: tokenInfo.is_valid,
      expires_at: tokenInfo.expires_at,
      scopes: tokenInfo.scopes,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not check token health' });
  }
});

module.exports = router;
