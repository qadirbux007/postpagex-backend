const jwt = require('jsonwebtoken');
const { query } = require('../../config/database');

/**
 * Protect routes — verifies JWT from Authorization header or cookie
 * Attaches req.user on success
 */
async function requireAuth(req, res, next) {
  try {
    let token = null;

    // Check Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    // Fallback: check httpOnly cookie
    if (!token && req.cookies && req.cookies.ppx_token) {
      token = req.cookies.ppx_token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Load fresh user from DB (catches deactivated accounts)
    const result = await query(
      'SELECT id, email, name, avatar_url, is_admin, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!result.rows.length || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Account not found or deactivated' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
}

/**
 * Admin-only middleware — use after requireAuth
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Generate a signed JWT for a user
 */
function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

/**
 * Set JWT as secure httpOnly cookie
 */
function setTokenCookie(res, token) {
  res.cookie('ppx_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

module.exports = { requireAuth, requireAdmin, generateToken, setTokenCookie };
