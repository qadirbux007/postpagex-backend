# PostPageX Backend

Complete Node.js + Express + PostgreSQL + Redis backend for PostPageX.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Database | PostgreSQL 15+ |
| Cache / Queue | Redis + Bull |
| Auth | JWT + Google OAuth + bcrypt |
| Facebook | Graph API v19.0 |
| Hosting (recommended) | Railway (DB + Redis + API) |

---

## Project Structure

```
postpagex-backend/
├── src/
│   ├── server.js           ← Express app entry point
│   ├── routes/
│   │   ├── auth.js         ← Google OAuth + email/password login
│   │   ├── facebook.js     ← Connect Pages, OAuth callback
│   │   ├── posts.js        ← Create, schedule, bulk import posts
│   │   └── analytics.js    ← Stats, insights, best times
│   ├── services/
│   │   ├── facebook.js     ← Graph API calls, token management
│   │   └── scheduler.js    ← Bull queue setup
│   ├── jobs/
│   │   └── worker.js       ← Background worker, publishes posts
│   ├── middleware/
│   │   └── auth.js         ← JWT verification middleware
│   └── utils/
│       └── encryption.js   ← AES-256 token encryption
├── config/
│   ├── database.js         ← PostgreSQL pool
│   ├── redis.js            ← Redis connection
│   └── logger.js           ← Winston logger
├── migrations/
│   ├── schema.sql          ← Full DB schema (all tables)
│   └── run.js              ← Migration runner
├── .env.example            ← Copy to .env and fill in
└── package.json
```

---

## Setup Guide

### Step 1 — Install dependencies

```bash
cd postpagex-backend
npm install
```

### Step 2 — Set up environment variables

```bash
cp .env.example .env
```

Fill in every value in `.env`. See comments in the file for where to get each one.

### Step 3 — Set up PostgreSQL

**Option A: Local (for development)**
```bash
# Install PostgreSQL, then:
createdb postpagex
psql postpagex -c "CREATE USER ppxuser WITH PASSWORD 'yourpassword';"
psql postpagex -c "GRANT ALL ON DATABASE postpagex TO ppxuser;"
# Set DATABASE_URL=postgresql://ppxuser:yourpassword@localhost:5432/postpagex
```

**Option B: Railway (recommended for production)**
1. Go to railway.app → New Project → Add PostgreSQL
2. Copy the `DATABASE_URL` from the Variables tab into your `.env`

### Step 4 — Set up Redis

**Option A: Local**
```bash
# macOS: brew install redis && brew services start redis
# Ubuntu: sudo apt install redis-server
# REDIS_URL=redis://localhost:6379
```

**Option B: Railway**
1. New Service → Add Redis
2. Copy `REDIS_URL` into your `.env`

### Step 5 — Run database migrations

```bash
npm run migrate
```

This creates all tables: users, facebook_pages, posts, analytics, sessions, etc.

### Step 6 — Set up Google OAuth

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or select existing)
3. APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
4. Application type: Web application
5. Authorized redirect URIs: `http://localhost:4000/auth/google/callback`
6. Copy Client ID and Client Secret into `.env`

### Step 7 — Set up Facebook App

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create a new App → Business type
3. Settings → Basic → copy App ID and App Secret into `.env`
4. Add Facebook Login product
5. Valid OAuth Redirect URI: `http://localhost:4000/facebook/callback`
6. Submit for App Review with these permissions:
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `pages_read_user_content`
   - `pages_manage_metadata`
   - `publish_video`

> **During development:** You can test with your own Facebook account without App Review. Add yourself as a test user in the app dashboard.

### Step 8 — Start the server

**Development (with auto-reload):**
```bash
npm run dev
```

**Start the post publishing worker (in a separate terminal):**
```bash
npm run worker
```

**Production:**
```bash
npm start
# And in a separate process/dyno:
npm run worker
```

---

## API Endpoints

### Auth
| Method | Endpoint | Description |
|---|---|---|
| GET | `/auth/google` | Start Google OAuth |
| GET | `/auth/google/callback` | Google OAuth callback |
| POST | `/auth/signup` | Email/password signup |
| POST | `/auth/login` | Email/password login |
| POST | `/auth/logout` | Clear session |
| GET | `/auth/me` | Get current user |

### Facebook
| Method | Endpoint | Description |
|---|---|---|
| GET | `/facebook/connect` | Get Facebook OAuth URL |
| GET | `/facebook/callback` | Facebook OAuth callback |
| GET | `/facebook/pages` | List connected pages |
| DELETE | `/facebook/pages/:id` | Disconnect a page |
| GET | `/facebook/pages/:id/token-health` | Check token validity |

### Posts
| Method | Endpoint | Description |
|---|---|---|
| GET | `/posts` | List posts (filter by status, page) |
| POST | `/posts` | Create or schedule a post |
| GET | `/posts/:id` | Get single post |
| PATCH | `/posts/:id` | Update draft/scheduled post |
| DELETE | `/posts/:id` | Delete or cancel post |
| POST | `/posts/bulk` | Bulk import from CSV data |

### Analytics
| Method | Endpoint | Description |
|---|---|---|
| GET | `/analytics/overview` | Dashboard stats |
| GET | `/analytics/pages/:id` | Page-level analytics |
| POST | `/analytics/sync/:id` | Sync insights from Facebook |
| GET | `/analytics/best-times/:id` | Best posting times |

---

## Connecting Frontend to Backend

In each HTML page, replace the fake data with real API calls. Example:

```javascript
// Login page — replace the fake setTimeout with:
async function handleSignin() {
  const response = await fetch('http://localhost:4000/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // sends cookies
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();
  if (response.ok) {
    window.location.href = 'dashboard.html';
  } else {
    showToast(data.error, 'error');
  }
}

// Dashboard — load real posts:
async function loadPosts() {
  const res = await fetch('http://localhost:4000/posts', { credentials: 'include' });
  const { posts } = await res.json();
  renderPosts(posts);
}

// Connect Facebook Pages:
async function connectFacebook() {
  const res = await fetch('http://localhost:4000/facebook/connect', { credentials: 'include' });
  const { url } = await res.json();
  window.location.href = url; // Redirect to Facebook OAuth
}
```

---

## Deployment on Railway

1. Push your code to GitHub
2. New Railway project → Deploy from GitHub repo
3. Add environment variables in Railway dashboard
4. Add PostgreSQL and Redis services
5. Set start command: `npm start`
6. Add a second service for the worker: `npm run worker`
7. Set `FRONTEND_URL` to your Vercel/Netlify frontend URL

---

## Security Notes

- Facebook tokens are encrypted with AES-256-GCM before database storage
- Passwords are hashed with bcrypt (cost factor 12)
- JWTs are stored in httpOnly cookies (not localStorage)
- Rate limiting on all auth and API endpoints
- CSRF protection on Facebook OAuth via state parameter
- Helmet.js sets secure HTTP headers
- Never commit `.env` to version control
