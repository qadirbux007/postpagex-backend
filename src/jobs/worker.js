require('dotenv').config();
const { postQueue } = require('../services/scheduler');
const fb = require('../services/facebook');
const { query } = require('../../config/database');
const { decrypt } = require('../utils/encryption');
const logger = require('../../config/logger');

logger.info('PostPageX worker started — listening for scheduled posts…');

postQueue.process(async (job) => {
  const { postId, pageId, userId } = job.data;
  logger.info('Processing post job', { jobId: job.id, postId });

  // 1. Fetch post from DB
  const postResult = await query(
    'SELECT * FROM posts WHERE id = $1 AND user_id = $2',
    [postId, userId]
  );

  if (!postResult.rows.length) {
    throw new Error(`Post ${postId} not found`);
  }

  const post = postResult.rows[0];

  // 2. Check post hasn't been cancelled
  if (post.status === 'cancelled') {
    logger.info('Post was cancelled, skipping', { postId });
    return { skipped: true };
  }

  // 3. Fetch the connected page (with decrypted token)
  const pageResult = await query(
    'SELECT * FROM facebook_pages WHERE id = $1 AND user_id = $2 AND is_active = true',
    [pageId, userId]
  );

  if (!pageResult.rows.length) {
    throw new Error(`Page ${pageId} not found or disconnected`);
  }

  const page = pageResult.rows[0];

  // 4. Mark as publishing
  await query(
    'UPDATE posts SET status = $1, updated_at = NOW() WHERE id = $2',
    ['publishing', postId]
  );

  // 5. Publish to Facebook
  const fbResult = await fb.publishPost(post, page);
  const fbPostId = fbResult.id;

  // 6. Build permalink
  const [pageIdStr, postIdNum] = fbPostId.split('_');
  const permalinkUrl = `https://www.facebook.com/${pageIdStr}/posts/${postIdNum}`;

  // 7. Mark as published in DB
  await query(
    `UPDATE posts SET
       status = 'published',
       published_at = NOW(),
       fb_post_id = $1,
       fb_permalink_url = $2,
       updated_at = NOW()
     WHERE id = $3`,
    [fbPostId, permalinkUrl, postId]
  );

  logger.info('Post published successfully', { postId, fbPostId, page: page.page_name });
  return { success: true, fbPostId, permalinkUrl };
});

// ── JOB EVENT HANDLERS ────────────────────────────────────

postQueue.on('completed', async (job, result) => {
  if (result?.success) {
    logger.info('Job completed', { jobId: job.id, fbPostId: result.fbPostId });
  }
});

postQueue.on('failed', async (job, err) => {
  const { postId } = job.data;
  logger.error('Job failed', { jobId: job.id, postId, error: err.message, attempts: job.attemptsMade });

  // If all retries exhausted, mark post as failed in DB
  if (job.attemptsMade >= job.opts.attempts) {
    await query(
      `UPDATE posts SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`,
      [err.message, postId]
    ).catch(dbErr => logger.error('Could not update failed post status', { error: dbErr.message }));
  }
});

postQueue.on('stalled', (job) => {
  logger.warn('Job stalled', { jobId: job.id, postId: job.data.postId });
});

postQueue.on('error', (err) => {
  logger.error('Queue error', { error: err.message });
});

// ── TOKEN REFRESH CRON ────────────────────────────────────
// Runs every 24 hours to check for tokens expiring in the next 7 days
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

async function refreshExpiringTokens() {
  logger.info('Checking for expiring Facebook tokens…');
  try {
    const result = await query(
      `SELECT fa.id, fa.access_token_enc, fa.user_id
       FROM facebook_accounts fa
       WHERE fa.is_active = true
       AND fa.token_expires_at < NOW() + INTERVAL '7 days'`
    );

    for (const account of result.rows) {
      try {
        const currentToken = decrypt(account.access_token_enc);
        const refreshed = await fb.extendToken(currentToken);
        const { encrypt } = require('../utils/encryption');
        const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);

        await query(
          'UPDATE facebook_accounts SET access_token_enc=$1, token_expires_at=$2, last_refreshed_at=NOW() WHERE id=$3',
          [encrypt(refreshed.access_token), newExpiry, account.id]
        );

        logger.info('Token refreshed', { accountId: account.id });
      } catch (tokenErr) {
        logger.warn('Could not refresh token', { accountId: account.id, error: tokenErr.message });
      }
    }
  } catch (err) {
    logger.error('Token refresh check failed', { error: err.message });
  }
}

// Run immediately then every 24h
refreshExpiringTokens();
setInterval(refreshExpiringTokens, REFRESH_INTERVAL);

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('Worker shutting down gracefully…');
  await postQueue.close();
  process.exit(0);
});
