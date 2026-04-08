-- ═══════════════════════════════════════════════════════
-- PostPageX Database Schema
-- Run with: node migrations/run.js
-- ═══════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USERS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  name            VARCHAR(255),
  avatar_url      TEXT,
  password_hash   TEXT,                    -- NULL if Google OAuth only
  google_id       VARCHAR(255) UNIQUE,     -- NULL if email/password only
  email_verified  BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  is_admin        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- ── FACEBOOK CONNECTIONS ────────────────────────────────
-- One row per Facebook account a user connects
-- A user can connect multiple FB accounts (for agencies)
CREATE TABLE IF NOT EXISTS facebook_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fb_user_id        VARCHAR(255) NOT NULL,
  fb_user_name      VARCHAR(255),
  -- Tokens are encrypted with AES-256 before storage
  access_token_enc  TEXT NOT NULL,
  token_expires_at  TIMESTAMPTZ,
  is_active         BOOLEAN DEFAULT TRUE,
  connected_at      TIMESTAMPTZ DEFAULT NOW(),
  last_refreshed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, fb_user_id)
);

CREATE INDEX IF NOT EXISTS idx_fb_accounts_user ON facebook_accounts(user_id);

-- ── FACEBOOK PAGES ──────────────────────────────────────
-- One row per Facebook Page connected to a user's account
CREATE TABLE IF NOT EXISTS facebook_pages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fb_account_id     UUID NOT NULL REFERENCES facebook_accounts(id) ON DELETE CASCADE,
  page_id           VARCHAR(255) NOT NULL,   -- Facebook's Page ID
  page_name         VARCHAR(255) NOT NULL,
  page_category     VARCHAR(255),
  page_picture_url  TEXT,
  page_fan_count    INTEGER DEFAULT 0,
  -- Page-level token (longer lived than user token)
  page_token_enc    TEXT NOT NULL,
  page_token_expires_at TIMESTAMPTZ,
  permissions       JSONB DEFAULT '[]',      -- Array of granted permissions
  is_active         BOOLEAN DEFAULT TRUE,
  color             VARCHAR(7) DEFAULT '#1A6BF0',  -- UI color for this page
  connected_at      TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at    TIMESTAMPTZ,
  metadata          JSONB DEFAULT '{}',
  UNIQUE(user_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_pages_user ON facebook_pages(user_id);
CREATE INDEX IF NOT EXISTS idx_pages_page_id ON facebook_pages(page_id);

-- ── POSTS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id           UUID NOT NULL REFERENCES facebook_pages(id) ON DELETE CASCADE,
  -- Content
  message           TEXT,
  link_url          TEXT,
  post_type         VARCHAR(20) DEFAULT 'text'  -- text | image | video | link | reel
                    CHECK (post_type IN ('text','image','video','link','reel')),
  media_urls        JSONB DEFAULT '[]',          -- Array of uploaded file URLs
  -- Scheduling
  status            VARCHAR(20) DEFAULT 'draft'
                    CHECK (status IN ('draft','scheduled','publishing','published','failed','cancelled')),
  scheduled_at      TIMESTAMPTZ,                 -- When to publish (NULL = immediate)
  published_at      TIMESTAMPTZ,                 -- Actual publish time (set by worker)
  -- Facebook response
  fb_post_id        VARCHAR(255),                -- Facebook's post ID after publish
  fb_permalink_url  TEXT,
  -- Job tracking
  job_id            VARCHAR(255),                -- Bull job ID
  retry_count       INTEGER DEFAULT 0,
  last_error        TEXT,
  -- Metadata
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  is_bulk           BOOLEAN DEFAULT FALSE,       -- came from CSV upload
  bulk_batch_id     UUID,                        -- group CSV posts together
  template_id       UUID                         -- if created from a template
);

CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_page ON posts(page_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at) WHERE status = 'scheduled';

-- ── MEDIA LIBRARY ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_files (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename      VARCHAR(255) NOT NULL,
  original_name VARCHAR(255),
  mime_type     VARCHAR(100),
  size_bytes    BIGINT,
  url           TEXT NOT NULL,           -- S3/local URL
  thumbnail_url TEXT,
  media_type    VARCHAR(20)              -- image | video
                CHECK (media_type IN ('image','video')),
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_user ON media_files(user_id);

-- ── TEMPLATES ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  message     TEXT,
  post_type   VARCHAR(20) DEFAULT 'text',
  media_urls  JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── BULK BATCHES ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulk_batches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename        VARCHAR(255),
  total_posts     INTEGER DEFAULT 0,
  processed_posts INTEGER DEFAULT 0,
  failed_posts    INTEGER DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','partial','failed')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- ── POST ANALYTICS ──────────────────────────────────────
-- Cached analytics data fetched from Facebook Graph API
CREATE TABLE IF NOT EXISTS post_analytics (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id       UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  page_id       UUID NOT NULL REFERENCES facebook_pages(id) ON DELETE CASCADE,
  -- Metrics (fetched from Facebook)
  reach         INTEGER DEFAULT 0,
  impressions   INTEGER DEFAULT 0,
  likes         INTEGER DEFAULT 0,
  comments      INTEGER DEFAULT 0,
  shares        INTEGER DEFAULT 0,
  clicks        INTEGER DEFAULT 0,
  video_views   INTEGER DEFAULT 0,      -- for video posts
  -- Timestamps
  fetched_at    TIMESTAMPTZ DEFAULT NOW(),
  metric_date   DATE DEFAULT CURRENT_DATE,
  UNIQUE(post_id, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_analytics_post ON post_analytics(post_id);
CREATE INDEX IF NOT EXISTS idx_analytics_page ON post_analytics(page_id);

-- ── PAGE ANALYTICS ──────────────────────────────────────
-- Daily snapshots of page-level metrics
CREATE TABLE IF NOT EXISTS page_analytics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  page_id         UUID NOT NULL REFERENCES facebook_pages(id) ON DELETE CASCADE,
  metric_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  fan_count       INTEGER DEFAULT 0,
  new_fans        INTEGER DEFAULT 0,
  page_views      INTEGER DEFAULT 0,
  page_reach      INTEGER DEFAULT 0,
  page_impressions INTEGER DEFAULT 0,
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_id, metric_date)
);

-- ── WEBHOOK SUBSCRIPTIONS ───────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  page_id     UUID NOT NULL REFERENCES facebook_pages(id) ON DELETE CASCADE,
  fb_page_id  VARCHAR(255) NOT NULL,
  subscribed  BOOLEAN DEFAULT FALSE,
  fields      JSONB DEFAULT '["feed","messages"]',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── SESSIONS ────────────────────────────────────────────
-- Used by express-session with connect-pg-simple
CREATE TABLE IF NOT EXISTS session (
  sid     VARCHAR NOT NULL COLLATE "default",
  sess    JSON NOT NULL,
  expire  TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

-- ── UPDATED_AT TRIGGER ──────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER posts_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
