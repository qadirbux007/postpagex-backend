const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const fb = require('../services/facebook');
const { query } = require('../../config/database');
const { decrypt } = require('../utils/encryption');
const logger = require('../../config/logger');

// ── STEP 1: Start Facebook OAuth ─────────────────────────
// Frontend calls this to get the redirect URL
router.get('/connect', requireAuth, (req, res) => {
  // Generate CSRF state token and store in session
  const state = crypto.randomBytes(16).toString('hex');
  req.session.fbOAuthState = state;
  req.session.fbOAuthUserId = req.user.id;

  const oauthUrl = fb.getOAuthUrl(state);
  res.json({ url: oauthUrl });
});

// ── STEP 2: Facebook redirects back here ─────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logger.warn('Facebook OAuth denied by user', { error });
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?fb_error=denied`);
  }

  // Verify CSRF state
  if (!state || state !== req.session.fbOAuthState) {
    logger.warn('Facebook OAuth state mismatch — possible CSRF');
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?fb_error=state_mismatch`);
  }

  const userId = req.session.fbOAuthUserId;
  if (!userId) {
    return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=session_expired`);
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

    // Clean up session state
    delete req.session.fbOAuthState;
    delete req.session.fbOAuthUserId;

    logger.info('Facebook connected successfully', { userId, pages: pages.length });
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?fb_connected=${pages.length}`);
  } catch (err) {
    logger.error('Facebook OAuth callback error', { error: err.message });
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?fb_error=connection_failed`);
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
    await query(
      'UPDATE facebook_pages SET is_active = false WHERE id = $1 AND user_id = $2',
      [req.params.pageId, req.user.id]
    );
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
  await query(
    'UPDATE facebook_pages SET color = $1 WHERE id = $2 AND user_id = $3',
    [color, req.params.pageId, req.user.id]
  );
  res.json({ message: 'Color updated' });
});

// ── CHECK TOKEN HEALTH ────────────────────────────────────
router.get('/pages/:pageId/token-health', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT page_token_enc, page_token_expires_at FROM facebook_pages WHERE id = $1 AND user_id = $2',
      [req.params.pageId, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Page not found' });

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
