const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { query } = require('../../config/database');
const fb = require('../services/facebook');
const { decrypt } = require('../utils/encryption');
const logger = require('../../config/logger');

// ── DASHBOARD OVERVIEW STATS ──────────────────────────────
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [pagesRes, postsRes, scheduledRes, reachRes] = await Promise.all([
      query('SELECT COUNT(*) FROM facebook_pages WHERE user_id=$1 AND is_active=true', [userId]),
      query(`SELECT COUNT(*) FROM posts WHERE user_id=$1 AND status='published'
             AND published_at > NOW() - INTERVAL '7 days'`, [userId]),
      query(`SELECT COUNT(*) FROM posts WHERE user_id=$1 AND status='scheduled'`, [userId]),
      query(`SELECT COALESCE(SUM(pa.reach),0) as total_reach,
                    COALESCE(SUM(pa.likes+pa.comments+pa.shares),0) as total_engagement
             FROM post_analytics pa
             JOIN posts p ON pa.post_id = p.id
             WHERE p.user_id=$1 AND pa.metric_date > NOW() - INTERVAL '7 days'`, [userId]),
    ]);

    res.json({
      pages_connected: parseInt(pagesRes.rows[0].count),
      posts_this_week: parseInt(postsRes.rows[0].count),
      scheduled_posts: parseInt(scheduledRes.rows[0].count),
      total_reach_7d:  parseInt(reachRes.rows[0].total_reach),
      total_engagement_7d: parseInt(reachRes.rows[0].total_engagement),
    });
  } catch (err) {
    logger.error('Overview stats error', { error: err.message });
    res.status(500).json({ error: 'Could not fetch overview stats' });
  }
});

// ── PAGE ANALYTICS ────────────────────────────────────────
router.get('/pages/:pageId', requireAuth, async (req, res) => {
  try {
    const { days = 30 } = req.query;

    // Get cached page analytics
    const result = await query(
      `SELECT metric_date, fan_count, new_fans, page_views, page_reach, page_impressions
       FROM page_analytics
       WHERE page_id = $1
       AND metric_date > NOW() - INTERVAL '${parseInt(days)} days'
       ORDER BY metric_date ASC`,
      [req.params.pageId]
    );

    // Top posts for this page
    const topPosts = await query(
      `SELECT p.id, p.message, p.published_at, p.fb_permalink_url,
              pa.reach, pa.likes, pa.comments, pa.shares
       FROM posts p
       LEFT JOIN post_analytics pa ON pa.post_id = p.id
       WHERE p.page_id = $1 AND p.user_id = $2 AND p.status = 'published'
       ORDER BY pa.reach DESC NULLS LAST
       LIMIT 10`,
      [req.params.pageId, req.user.id]
    );

    res.json({
      daily: result.rows,
      top_posts: topPosts.rows,
    });
  } catch (err) {
    logger.error('Page analytics error', { error: err.message });
    res.status(500).json({ error: 'Could not fetch analytics' });
  }
});

// ── SYNC ANALYTICS FROM FACEBOOK ─────────────────────────
// Called by a cron job or manually triggered
router.post('/sync/:pageId', requireAuth, async (req, res) => {
  try {
    const pageResult = await query(
      'SELECT * FROM facebook_pages WHERE id=$1 AND user_id=$2 AND is_active=true',
      [req.params.pageId, req.user.id]
    );

    if (!pageResult.rows.length) {
      return res.status(404).json({ error: 'Page not found' });
    }

    const page = pageResult.rows[0];
    const pageToken = decrypt(page.page_token_enc);

    // Fetch unpublished post insights
    const unsynced = await query(
      `SELECT id, fb_post_id FROM posts
       WHERE page_id=$1 AND status='published' AND fb_post_id IS NOT NULL
       AND id NOT IN (SELECT post_id FROM post_analytics WHERE metric_date = CURRENT_DATE)
       LIMIT 50`,
      [req.params.pageId]
    );

    let synced = 0;
    for (const post of unsynced.rows) {
      const insights = await fb.fetchPostInsights(post.fb_post_id, pageToken);
      if (insights) {
        await query(
          `INSERT INTO post_analytics (post_id, page_id, reach, impressions, likes, comments, shares, clicks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (post_id, metric_date) DO UPDATE SET
             reach=$3, impressions=$4, likes=$5, comments=$6, shares=$7, clicks=$8, fetched_at=NOW()`,
          [post.id, req.params.pageId, insights.reach, insights.impressions,
           insights.likes, insights.comments, insights.shares, insights.clicks]
        );
        synced++;
      }
    }

    res.json({ message: `Synced ${synced} posts`, synced });
  } catch (err) {
    logger.error('Analytics sync error', { error: err.message });
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ── BEST POSTING TIMES ────────────────────────────────────
router.get('/best-times/:pageId', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT EXTRACT(DOW FROM p.published_at) as day_of_week,
              EXTRACT(HOUR FROM p.published_at) as hour,
              AVG(pa.reach) as avg_reach,
              COUNT(*) as post_count
       FROM posts p
       JOIN post_analytics pa ON pa.post_id = p.id
       WHERE p.page_id = $1 AND p.user_id = $2 AND p.status = 'published'
       GROUP BY day_of_week, hour
       HAVING COUNT(*) >= 2
       ORDER BY avg_reach DESC
       LIMIT 5`,
      [req.params.pageId, req.user.id]
    );

    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    const bestTimes = result.rows.map(row => ({
      day: days[parseInt(row.day_of_week)],
      hour: parseInt(row.hour),
      avg_reach: Math.round(row.avg_reach),
      post_count: parseInt(row.post_count),
      label: `${days[parseInt(row.day_of_week)]} ${parseInt(row.hour)}:00`,
    }));

    res.json({ best_times: bestTimes });
  } catch (err) {
    res.status(500).json({ error: 'Could not calculate best times' });
  }
});

module.exports = router;
