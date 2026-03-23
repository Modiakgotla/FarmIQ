# FarmIQ — Supabase Setup Guide

## What this fixes
- ✅ Real database (PostgreSQL via Supabase) — data persists across devices/browsers
- ✅ Real auth — bcrypt password hashing, JWT sessions, auto-refresh
- ✅ Row Level Security — users can ONLY see their own farms and reports
- ✅ Claude API key never touches the browser — lives in Supabase Edge Function secrets
- ✅ Usage limits enforced server-side — can't be bypassed by clearing localStorage

---

## Step 1 — Create Supabase project (free)

1. Go to **supabase.com** → New project
2. Choose a name: `farmiq-production`
3. Set a strong database password (save it!)
4. Region: **Europe West** (closest to SA)
5. Wait ~2 minutes for project to spin up

---

## Step 2 — Run the database migration

1. Supabase Dashboard → **SQL Editor** → New Query
2. Copy & paste the entire contents of `supabase/migrations/001_initial_schema.sql`
3. Click **Run**
4. Verify: Table Editor should show `profiles`, `farms`, `reports` tables

---

## Step 3 — Configure index.html

Open `index.html` and replace the two placeholder values at the top of the `<script>` section:

```js
const SUPABASE_URL     = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';
```

Find these values in:
**Supabase Dashboard → Project Settings → API**
- `SUPABASE_URL` = Project URL
- `SUPABASE_ANON_KEY` = `anon` `public` key (safe to expose in browser)

---

## Step 4 — Deploy the Edge Function (Claude AI proxy)

Install Supabase CLI:
```bash
npm install -g supabase
```

Login and link to your project:
```bash
supabase login
supabase link --project-ref YOUR_PROJECT_ID
```

Set your Anthropic API key as a secret (never goes in code):
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-api03-...
```

Deploy the function:
```bash
supabase functions deploy analyze
```

Verify it's live:
**Supabase Dashboard → Edge Functions → analyze → should show "Active"**

---

## Step 5 — Configure Auth settings

**Supabase Dashboard → Authentication → Providers → Email:**

For development/testing:
- Toggle **"Confirm email"** OFF → users can sign in immediately without email confirmation

For production:
- Keep **"Confirm email"** ON
- Set **"Site URL"** to your Vercel domain (e.g. `https://farmiq.vercel.app`)
- Add your domain to **"Redirect URLs"**

---

## Step 6 — Deploy to Vercel

```bash
# In the farmiq-supabase folder
vercel deploy
```

No environment variables needed on Vercel — the Anthropic key lives in Supabase secrets,
and the Supabase anon key is safe to be public (RLS protects all data).

---

## Security model — how it all fits together

```
Browser                  Supabase                    External
──────────               ────────                    ────────
User signs up     ──▶    auth.users (bcrypt hash)
JWT issued        ◀──    auto-refresh every hour
                  
Analyse click     ──▶    Edge Function /analyze
  + JWT token            → verify JWT (real user?)
                         → check usage limit (DB)
                         → call Anthropic API        ──▶  Claude
                         → increment counter (DB)    ◀──  response
response          ◀──    return result

Save farm         ──▶    farms table (RLS: user_id = auth.uid())
Load reports      ──▶    reports table (RLS: user_id = auth.uid())
```

**Row Level Security means:**
- Even if someone gets your Supabase anon key, they cannot read other users' data
- Every query is automatically filtered to `WHERE user_id = authenticated_user_id`
- The service role key (used only in Edge Functions) never leaves the server

---

## Monthly usage reset (optional cron)

Add this to Supabase Dashboard → Database → Extensions → pg_cron:

```sql
select cron.schedule(
  'reset-monthly-usage',
  '0 0 1 * *',  -- midnight on 1st of each month
  'select public.reset_monthly_usage()'
);
```

Or call it manually from the SQL Editor whenever needed.

---

## Files in this package

```
farmiq-supabase/
├── index.html                           ← Complete frontend (Supabase-integrated)
├── supabase/
│   ├── migrations/
│   │   └── 001_initial_schema.sql       ← Run this in Supabase SQL Editor
│   └── functions/
│       └── analyze/
│           └── index.ts                 ← Edge Function (Claude API proxy)
└── SETUP.md                             ← This file
```
