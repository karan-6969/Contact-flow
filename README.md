# ContactFlow
Your contacts. Finally organized. Google Contacts are read-only; categories live in your Supabase database.

## Quick Start (Instant Local Run)
Zero configuration needed to try it out:
1. `npm install`
2. `npm run dev` (or `npm start`)
3. Open **http://localhost:3000** in your browser.
By default, ContactFlow runs with a built-in local SQLite database (`data/contactflow.sqlite`) and simulated contacts in demo mode.

## Connect Supabase (Optional)
To use a cloud Supabase PostgreSQL database instead of local SQLite:
1. Create a project at [supabase.com](https://supabase.com), open SQL Editor, and run `supabase/migration.sql`.
2. Copy your **Project URL** and `service_role` secret key (Project Settings > API).
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
4. Restart the server. ContactFlow will automatically switch to Supabase.

## Real Google login
1. console.cloud.google.com > new project > **APIs & Services > Library > enable "People API"**.
2. **OAuth consent screen**: External, add scope `.../auth/contacts.readonly`, add yourself as a test user.
3. **Credentials > Create OAuth client ID > Web application**. Authorized redirect URI: `http://localhost:3000/api/auth/callback` (add your production URL too).
4. Put the ID/secret/redirect URI in `.env`. Restart. Contacts sync on first login.
(Public launch needs Google's OAuth verification because contacts.readonly is a sensitive scope.)

## Deploy
Any Node host (Render, Railway, Fly): set the env vars, `NODE_ENV=production`, build `npm install`, start `npm start`. Use HTTPS and set `GOOGLE_REDIRECT_URI` to your live domain.

## Notes
Auth is a signed HTTP-only cookie; every query is scoped to the signed-in user; mutating calls require a custom header (CSRF). Drag-and-drop works with mouse and touch (long-press a card, then drag onto a category). Already ran an older migration? Run: `alter table contacts add column favorite boolean not null default false;`
