const express = require('express');
const router = express.Router();
const { body, query: vQuery, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../../config/database');
const postScheduler = require('../services/scheduler');
const logger = require('../../config/logger');

// ── GET POSTS ─────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, page_id, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT p.*, fp.page_name, fp.page_picture_url, fp.color as page_color
      FROM posts p
      JOIN facebook_pages fp ON p.page_id = fp.id
      WHERE p.user_id = $1
    `;
    const params = [req.user.id];
    let paramIdx = 2;

    if (status) {
      sql += ` AND p.status = $${paramIdx++}`;
      params.push(status);
    }
    if (page_id) {
      sql += ` AND p.page_id = $${paramIdx++}`;
      params.push(page_id);
    }

    sql += ` ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    res.json({ posts: result.rows, count: result.rowCount });
  } catch (err) {
    logger.error('Get posts error', { error: err.message });
    res.status(500).json({ error: 'Could not fetch posts' });
  }
});

// ── CREATE / SCHEDULE POST ────────────────────────────────
router.post('/', requireAuth, [
  body('page_id').isUUID().withMessage('Valid page ID required'),
  body('message').optional().isString().isLength({ max: 63206 }),
  body('post_type').isIn(['text','image','video','link','reel']),
  body('scheduled_at').optional().isISO8601().toDate(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { page_id, message, post_type, media_urls, link_url, scheduled_at } = req.body;

  try {
    // Verify page belongs to user
    const pageCheck = await query(
      'SELECT id FROM facebook_pages WHERE id = $1 AND user_id = $2 AND is_active = true',
      [page_id, req.user.id]
    );
    if (!pageCheck.rows.length) {
      return res.status(404).json({ error: 'Page not found or not connected' });
    }

    const status = scheduled_at ? 'scheduled' : 'publishing';

    const result = await query(
      `INSERT INTO posts (user_id, page_id, message, post_type, media_urls, link_url, scheduled_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.id, page_id, message, post_type, JSON.stringify(media_urls || []), link_url, scheduled_at, status]
    );

    const post = result.rows[0];

    if (scheduled_at) {
      // Add to Bull queue for future publishing
      const job = await postScheduler.schedulePost(post, new Date(scheduled_at));
      await query('UPDATE posts SET job_id = $1 WHERE id = $2', [job.id.toString(), post.id]);
      logger.info('Post scheduled', { postId: post.id, scheduledAt: scheduled_at });
      res.status(201).json({ post, message: 'Post scheduled successfully' });
    } else {
      // Publish immediately via queue (slight delay for response)
      await postScheduler.publishNow(post);
      logger.info('Post queued for immediate publish', { postId: post.id });
      res.status(201).json({ post, message: 'Post is being published now' });
    }
  } catch (err) {
    logger.error('Create post error', { error: err.message });
    res.status(500).json({ error: 'Could not create post' });
  }
});

// ── GET SINGLE POST ───────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, fp.page_name, fp.color as page_color,
              pa.reach, pa.impressions, pa.likes, pa.comments, pa.shares
       FROM posts p
       JOIN facebook_pages fp ON p.page_id = fp.id
       LEFT JOIN post_analytics pa ON pa.post_id = p.id
       WHERE p.id = $1 AND p.user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch post' });
  }
});

// ── UPDATE POST (only drafts/scheduled) ──────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const existing = await query(
      'SELECT * FROM posts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (!existing.rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = existing.rows[0];

    if (!['draft', 'scheduled'].includes(post.status)) {
      return res.status(400).json({ error: 'Only draft or scheduled posts can be edited' });
    }

    const { message, scheduled_at, media_urls, link_url } = req.body;

    // If rescheduling, remove old job and create new one
    if (scheduled_at && post.job_id) {
      await postScheduler.cancelJob(post.job_id);
    }

    const result = await query(
      `UPDATE posts SET message=$1, scheduled_at=$2, media_urls=$3, link_url=$4, updated_at=NOW()
       WHERE id=$5 AND user_id=$6 RETURNING *`,
      [message ?? post.message, scheduled_at ?? post.scheduled_at,
       JSON.stringify(media_urls ?? post.media_urls), link_url ?? post.link_url,
       req.params.id, req.user.id]
    );

    const updated = result.rows[0];
    if (scheduled_at) {
      const job = await postScheduler.schedulePost(updated, new Date(scheduled_at));
      await query('UPDATE posts SET job_id = $1 WHERE id = $2', [job.id.toString(), updated.id]);
    }

    res.json({ post: updated });
  } catch (err) {
    logger.error('Update post error', { error: err.message });
    res.status(500).json({ error: 'Could not update post' });
  }
});

// ── DELETE / CANCEL POST ──────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM posts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = result.rows[0];

    // Cancel queued job if exists
    if (post.job_id) {
      await postScheduler.cancelJob(post.job_id);
    }

    if (post.status === 'published') {
      // Mark as cancelled but keep record for analytics
      await query('UPDATE posts SET status = $1 WHERE id = $2', ['cancelled', post.id]);
    } else {
      await query('DELETE FROM posts WHERE id = $1', [post.id]);
    }

    res.json({ message: 'Post deleted successfully' });
  } catch (err) {
    logger.error('Delete post error', { error: err.message });
    res.status(500).json({ error: 'Could not delete post' });
  }
});

// ── BULK IMPORT FROM CSV ──────────────────────────────────
router.post('/bulk', requireAuth, async (req, res) => {
  const { posts: bulkPosts } = req.body;

  if (!Array.isArray(bulkPosts) || bulkPosts.length === 0) {
    return res.status(400).json({ error: 'No posts provided' });
  }
  if (bulkPosts.length > 500) {
    return res.status(400).json({ error: 'Maximum 500 posts per bulk upload' });
  }

  try {
    // Create batch record
    const batchResult = await query(
      'INSERT INTO bulk_batches (user_id, total_posts, status) VALUES ($1, $2, $3) RETURNING id',
      [req.user.id, bulkPosts.length, 'processing']
    );
    const batchId = batchResult.rows[0].id;

    let processed = 0, failed = 0;
    const results = [];

    for (const p of bulkPosts) {
      try {
        // Verify page
        const pageCheck = await query(
          'SELECT id FROM facebook_pages WHERE page_name = $1 AND user_id = $2 AND is_active = true',
          [p.page_name, req.user.id]
        );

        if (!pageCheck.rows.length) {
          results.push({ ...p, error: `Page "${p.page_name}" not found`, status: 'failed' });
          failed++;
          continue;
        }

        const pageId = pageCheck.rows[0].id;
        const scheduledAt = p.scheduled_date && p.scheduled_time
          ? new Date(`${p.scheduled_date} ${p.scheduled_time}`)
          : null;

        const postResult = await query(
          `INSERT INTO posts (user_id, page_id, message, post_type, media_urls, scheduled_at, status, is_bulk, bulk_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8) RETURNING id`,
          [req.user.id, pageId, p.message, p.post_type || 'text',
           JSON.stringify(p.media_urls || []), scheduledAt,
           scheduledAt ? 'scheduled' : 'draft', batchId]
        );

        if (scheduledAt) {
          await postScheduler.schedulePost(postResult.rows[0], scheduledAt);
        }

        processed++;
        results.push({ ...p, id: postResult.rows[0].id, status: 'imported' });
      } catch (rowErr) {
        failed++;
        results.push({ ...p, error: rowErr.message, status: 'failed' });
      }
    }

    await query(
      'UPDATE bulk_batches SET processed_posts=$1, failed_posts=$2, status=$3, completed_at=NOW() WHERE id=$4',
      [processed, failed, failed === bulkPosts.length ? 'failed' : processed > 0 ? 'completed' : 'partial', batchId]
    );

    res.json({ batchId, total: bulkPosts.length, processed, failed, results });
  } catch (err) {
    logger.error('Bulk import error', { error: err.message });
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

module.exports = router;
