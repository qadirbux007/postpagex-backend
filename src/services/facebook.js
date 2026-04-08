const axios = require('axios');
const { query } = require('../../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../../config/logger');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION}`;

// ── OAUTH URL BUILDER ────────────────────────────────────
function getOAuthUrl(state) {
  const permissions = [
    'pages_show_list',
    'pages_manage_posts',
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_manage_metadata',
    'publish_video',
  ].join(',');

  const params = new URLSearchParams({
    client_id:     process.env.FACEBOOK_APP_ID,
    redirect_uri:  process.env.FACEBOOK_CALLBACK_URL,
    scope:         permissions,
    response_type: 'code',
    state,           // CSRF protection token
  });

  return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
}

// ── EXCHANGE CODE FOR USER TOKEN ─────────────────────────
async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id:     process.env.FACEBOOK_APP_ID,
    client_secret: process.env.FACEBOOK_APP_SECRET,
    redirect_uri:  process.env.FACEBOOK_CALLBACK_URL,
    code,
  });

  const res = await axios.get(`${GRAPH_BASE}/oauth/access_token?${params}`);
  return res.data; // { access_token, token_type, expires_in }
}

// ── EXTEND SHORT-LIVED TOKEN TO LONG-LIVED ───────────────
async function extendToken(shortToken) {
  const params = new URLSearchParams({
    grant_type:        'fb_exchange_token',
    client_id:         process.env.FACEBOOK_APP_ID,
    client_secret:     process.env.FACEBOOK_APP_SECRET,
    fb_exchange_token: shortToken,
  });

  const res = await axios.get(`${GRAPH_BASE}/oauth/access_token?${params}`);
  return res.data; // { access_token, token_type, expires_in }
}

// ── GET FB USER INFO ─────────────────────────────────────
async function getFbUserInfo(accessToken) {
  const res = await axios.get(`${GRAPH_BASE}/me`, {
    params: { fields: 'id,name', access_token: accessToken },
  });
  return res.data;
}

// ── GET PAGES MANAGED BY USER ────────────────────────────
async function getManagedPages(userAccessToken) {
  const res = await axios.get(`${GRAPH_BASE}/me/accounts`, {
    params: {
      fields: 'id,name,category,fan_count,picture,access_token,tasks',
      access_token: userAccessToken,
    },
  });
  return res.data.data || [];
}

// ── SAVE FB CONNECTION TO DATABASE ───────────────────────
async function saveConnection(userId, userToken, longToken, tokenExpiresIn) {
  const fbUser = await getFbUserInfo(longToken);
  const pages = await getManagedPages(longToken);

  const expiresAt = tokenExpiresIn
    ? new Date(Date.now() + tokenExpiresIn * 1000)
    : null;

  // Upsert facebook_account
  const accountResult = await query(
    `INSERT INTO facebook_accounts (user_id, fb_user_id, fb_user_name, access_token_enc, token_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, fb_user_id) DO UPDATE
     SET access_token_enc = $4, token_expires_at = $5, last_refreshed_at = NOW(), is_active = true
     RETURNING id`,
    [userId, fbUser.id, fbUser.name, encrypt(longToken), expiresAt]
  );

  const accountId = accountResult.rows[0].id;

  // Upsert each page
  const savedPages = [];
  for (const page of pages) {
    const pictureUrl = page.picture?.data?.url || null;
    const pageTokenExpiresAt = null; // Page tokens don't expire unless user token revoked

    const pageResult = await query(
      `INSERT INTO facebook_pages
         (user_id, fb_account_id, page_id, page_name, page_category, page_picture_url,
          page_fan_count, page_token_enc, permissions, page_token_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, page_id) DO UPDATE SET
         page_name = $4, page_category = $5, page_picture_url = $6,
         page_fan_count = $7, page_token_enc = $8, permissions = $9,
         is_active = true, last_synced_at = NOW()
       RETURNING *`,
      [
        userId, accountId, page.id, page.name, page.category || null,
        pictureUrl, page.fan_count || 0, encrypt(page.access_token),
        JSON.stringify(page.tasks || []), pageTokenExpiresAt,
      ]
    );

    savedPages.push(pageResult.rows[0]);
  }

  logger.info('Facebook pages connected', { userId, pageCount: savedPages.length });
  return { account: accountResult.rows[0], pages: savedPages };
}

// ── PUBLISH A POST ───────────────────────────────────────
async function publishPost(post, page) {
  const pageToken = decrypt(page.page_token_enc);
  let endpoint, payload;

  switch (post.post_type) {
    case 'video':
    case 'reel':
      // Video uses a different endpoint
      endpoint = `${GRAPH_BASE}/${page.page_id}/videos`;
      payload = {
        description: post.message || '',
        access_token: pageToken,
      };
      if (post.media_urls?.[0]) {
        payload.file_url = post.media_urls[0];
      }
      break;

    case 'image':
      endpoint = `${GRAPH_BASE}/${page.page_id}/photos`;
      payload = {
        caption: post.message || '',
        url: post.media_urls?.[0],
        access_token: pageToken,
      };
      break;

    case 'link':
      endpoint = `${GRAPH_BASE}/${page.page_id}/feed`;
      payload = {
        message: post.message || '',
        link: post.link_url,
        access_token: pageToken,
      };
      break;

    default: // text
      endpoint = `${GRAPH_BASE}/${page.page_id}/feed`;
      payload = {
        message: post.message,
        access_token: pageToken,
      };
  }

  const res = await axios.post(endpoint, payload);
  return res.data; // { id: "page_id_post_id" }
}

// ── FETCH POST INSIGHTS ──────────────────────────────────
async function fetchPostInsights(fbPostId, pageToken) {
  try {
    const metrics = 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks';
    const res = await axios.get(`${GRAPH_BASE}/${fbPostId}/insights`, {
      params: { metric: metrics, access_token: pageToken },
    });

    const data = {};
    for (const item of res.data.data) {
      data[item.name] = item.values?.[0]?.value || 0;
    }

    // Also fetch reactions (likes etc.)
    const reactRes = await axios.get(`${GRAPH_BASE}/${fbPostId}`, {
      params: { fields: 'likes.summary(true),comments.summary(true),shares', access_token: pageToken },
    });

    return {
      impressions:  data.post_impressions || 0,
      reach:        data.post_impressions_unique || 0,
      engaged:      data.post_engaged_users || 0,
      clicks:       data.post_clicks || 0,
      likes:        reactRes.data.likes?.summary?.total_count || 0,
      comments:     reactRes.data.comments?.summary?.total_count || 0,
      shares:       reactRes.data.shares?.count || 0,
    };
  } catch (err) {
    logger.warn('Could not fetch post insights', { fbPostId, error: err.message });
    return null;
  }
}

// ── TOKEN HEALTH CHECK ───────────────────────────────────
async function debugToken(accessToken) {
  const res = await axios.get(`${GRAPH_BASE}/debug_token`, {
    params: {
      input_token: accessToken,
      access_token: `${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}`,
    },
  });
  return res.data.data;
}

module.exports = {
  getOAuthUrl,
  exchangeCodeForToken,
  extendToken,
  saveConnection,
  publishPost,
  fetchPostInsights,
  debugToken,
  getManagedPages,
};
