const Bull = require('bull');
const logger = require('../../config/logger');

// Create the post publishing queue backed by Redis
const postQueue = new Bull('post-publishing', process.env.REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,               // retry up to 3 times on failure
    backoff: {
      type: 'exponential',
      delay: 5000,             // 5s, 10s, 20s between retries
    },
    removeOnComplete: false,   // keep completed jobs for audit
    removeOnFail: false,       // keep failed jobs for inspection
  },
});

/**
 * Schedule a post to be published at a specific time
 */
async function schedulePost(post, scheduledAt) {
  const delay = scheduledAt.getTime() - Date.now();

  if (delay < 0) {
    throw new Error('Scheduled time is in the past');
  }

  const job = await postQueue.add(
    { postId: post.id, pageId: post.page_id, userId: post.user_id },
    { delay, jobId: `post-${post.id}` }
  );

  logger.info('Post scheduled in queue', {
    jobId: job.id, postId: post.id,
    scheduledAt: scheduledAt.toISOString(),
    delayMs: delay,
  });

  return job;
}

/**
 * Publish a post immediately (small delay for response)
 */
async function publishNow(post) {
  const job = await postQueue.add(
    { postId: post.id, pageId: post.page_id, userId: post.user_id },
    { delay: 500 } // 500ms so the API response goes first
  );

  logger.info('Post queued for immediate publish', { jobId: job.id, postId: post.id });
  return job;
}

/**
 * Cancel a scheduled job (e.g., post deleted or rescheduled)
 */
async function cancelJob(jobId) {
  try {
    const job = await postQueue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'delayed' || state === 'waiting') {
        await job.remove();
        logger.info('Job cancelled', { jobId });
        return true;
      }
    }
    return false;
  } catch (err) {
    logger.warn('Could not cancel job', { jobId, error: err.message });
    return false;
  }
}

/**
 * Get queue stats (for admin monitoring)
 */
async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    postQueue.getWaitingCount(),
    postQueue.getActiveCount(),
    postQueue.getCompletedCount(),
    postQueue.getFailedCount(),
    postQueue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

module.exports = { postQueue, schedulePost, publishNow, cancelJob, getQueueStats };
