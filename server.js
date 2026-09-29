import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { createLocalClient } from './local-db.js';

const { GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: SEC, GOOGLE_REDIRECT_URI: REDIR = 'http://localhost:3000/api/auth/callback', SUPABASE_SERVICE_ROLE_KEY, PORT = 3000 } = process.env;
const rawUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'cf-secret-' + crypto.randomBytes(24).toString('hex');
const DEMO = !CID || !SEC, prod = process.env.NODE_ENV === 'production';
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const sb = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : createLocalClient();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60000, limit: 300 }));
// CSRF: SameSite=Lax cookie + custom header required on every mutating request
app.use('/api', (q, s, n) => q.method === 'GET' || q.get('x-cf') ? n() : s.status(403).json({ error: 'Blocked request.' }));

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const isId = s => /^[0-9a-f-]{36}$/i.test(s || '');
const h = fn => (q, s) => fn(q, s).catch(e => {
  if (e?.code === '23503' && String(e?.message || '').includes('users')) {
    s.clearCookie('cf');
    return s.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
  console.error(e);
  s.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on our side. Try again.' });
});
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: prod };
const auth = (q, s, n) => { try { q.uid = jwt.verify(q.cookies.cf, SESSION_SECRET).uid; n(); } catch { s.clearCookie('cf'); s.status(401).json({ error: 'Your session expired. Sign in again.' }); } };
const login = (s, uid) => s.cookie('cf', jwt.sign({ uid }, SESSION_SECRET, { expiresIn: '14d' }), { ...cookieOpts, maxAge: 12096e5 });
const upsertUser = async r => { const { data, error } = await sb.from('users').upsert({ ...r, updated_at: new Date() }, { onConflict: 'google_id' }).select('id,email,name,avatar_url').single(); if (error) throw error; return data; };
const revoke = async uid => { const { data } = await sb.from('users').select('google_refresh_token').eq('id', uid).single(); if (data?.google_refresh_token) await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: data.google_refresh_token }) }).catch(() => {}); await sb.from('users').update({ google_refresh_token: null }).eq('id', uid); };

// ---- Auth
app.get('/api/auth/google', h(async (q, s) => {
  if (DEMO) { const u = await upsertUser({ google_id: 'demo', email: 'demo@contactflow.local', name: 'Demo User' }); login(s, u.id); return s.redirect('/app'); }
  const st = crypto.randomBytes(16).toString('hex');
  s.cookie('cf_st', st, { ...cookieOpts, maxAge: 6e5 });
  s.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CID,
    redirect_uri: REDIR,
    response_type: 'code',
    scope: 'openid email profile https://www.googleapis.com/auth/contacts.readonly',
    access_type: 'offline',
    prompt: 'consent select_account',
    state: st
  }));
}));
app.get('/api/auth/demo', h(async (q, s) => {
  const u = await upsertUser({ google_id: 'demo_user_preview', email: 'preview@contactflow.studio', name: 'Karan Bhatt' });
  login(s, u.id);
  const { data: existingCats } = await sb.from('categories').select('id,name').eq('user_id', u.id);
  let catMap = {};
  if (!existingCats || existingCats.length === 0) {
    const defaultCats = [
      { name: 'Core Team', color: '#5E5CE6', user_id: u.id, position: 0 },
      { name: 'Clients', color: '#0A84FF', user_id: u.id, position: 1 },
      { name: 'Investors', color: '#30D158', user_id: u.id, position: 2 },
      { name: 'Designers', color: '#FF9F0A', user_id: u.id, position: 3 },
      { name: 'VIP Friends', color: '#FF375F', user_id: u.id, position: 4 }
    ];
    const { data: insertedCats } = await sb.from('categories').insert(defaultCats).select();
    (insertedCats || []).forEach(c => { catMap[c.name] = c.id; });
  } else {
    existingCats.forEach(c => { catMap[c.name] = c.id; });
  }
  const { data: existingContacts } = await sb.from('contacts').select('id').eq('user_id', u.id).limit(1);
  if (!existingContacts || existingContacts.length === 0) {
    const starter = demo().slice(0, 16);
    const catIds = Object.values(catMap);
    for (let i = 0; i < starter.length; i++) {
      const c = starter[i];
      const { data: insertedContact } = await sb.from('contacts').insert({ ...c, user_id: u.id }).select('id').single();
      if (insertedContact && i < 9 && catIds.length > 0) {
        const assignedCatId = catIds[i % catIds.length];
        await sb.from('contact_categories').insert({ contact_id: insertedContact.id, category_id: assignedCatId });
      }
    }
  }
  s.redirect('/app');
}));
app.get('/api/auth/callback', h(async (q, s) => {
  const { code, state, error } = q.query;
  if (error || !code || state !== q.cookies.cf_st) return s.redirect('/?error=auth');
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: CID, client_secret: SEC, redirect_uri: REDIR, grant_type: 'authorization_code' }) })).json();
  if (!t.access_token) return s.redirect('/?error=auth');
  if (!t.scope || !t.scope.includes('contacts.readonly')) {
    console.warn('User signed in but did not grant contacts.readonly scope. Granted:', t.scope);
    return s.redirect('/?error=contacts_permission');
  }
  const p = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
  const row = { google_id: p.sub, email: p.email, name: p.name, avatar_url: p.picture };
  if (t.refresh_token) row.google_refresh_token = t.refresh_token;
  const u = await upsertUser(row); login(s, u.id); s.clearCookie('cf_st'); s.redirect('/app');
}));
app.get('/api/auth/me', auth, h(async (q, s) => { const { data } = await sb.from('users').select('id,email,name,avatar_url').eq('id', q.uid).maybeSingle(); if (!data) throw bad('Your session expired. Sign in again.', 401); s.json({ ...data, demo: DEMO }); }));
app.post('/api/auth/logout', (q, s) => { s.clearCookie('cf'); s.status(204).end(); });
app.post('/api/auth/disconnect', auth, h(async (q, s) => { await revoke(q.uid); s.status(204).end(); }));
app.delete('/api/account', auth, h(async (q, s) => { await revoke(q.uid); const { error } = await sb.from('users').delete().eq('id', q.uid); if (error) throw error; s.clearCookie('cf'); s.status(204).end(); }));

// ---- Google People API (read-only; ContactFlow never writes to Google)
const reconnect = () => bad('Reconnect Google to sync your contacts.', 409);
async function googleContacts(uid) {
  const { data: u } = await sb.from('users').select('google_refresh_token').eq('id', uid).single();
  if (!u?.google_refresh_token) throw reconnect();
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: CID, client_secret: SEC, refresh_token: u.google_refresh_token, grant_type: 'refresh_token' }) })).json();
  if (!t.access_token) throw reconnect();
  let out = [], pt = '';
  do {
    const r = await fetch('https://people.googleapis.com/v1/people/me/connections?' + new URLSearchParams({ personFields: 'names,emailAddresses,phoneNumbers,organizations,photos', pageSize: '1000', ...(pt && { pageToken: pt }) }), { headers: { Authorization: 'Bearer ' + t.access_token } });
    if (r.status === 403) {
      const errJson = await r.json().catch(() => ({}));
      console.warn('Google People API 403:', JSON.stringify(errJson));
      if (errJson?.error?.details?.some(d => d.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
        throw bad('Contact permission was not granted. Please sign out and sign in again, making sure to check the "See and download your contacts" box.', 403);
      }
      throw bad('ContactFlow needs permission to read your Google Contacts. Reconnect and allow contact access.', 403);
    }
    if (r.status === 429) throw bad('Google is rate limiting requests. Try again in a minute.', 429);
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('Google People API Error:', r.status, errText);
      throw bad("Google couldn't load your contacts right now. Try again in a moment.", 502);
    }
    const j = await r.json(); out.push(...(j.connections || [])); pt = j.nextPageToken;
  } while (pt);
  return out.map(p => { const n = p.names?.[0] || {}, o = p.organizations?.[0] || {}; return {
    google_resource_name: p.resourceName,
    name: n.displayName || p.emailAddresses?.[0]?.value || p.phoneNumbers?.[0]?.value || 'Unnamed',
    first_name: n.givenName || null, last_name: n.familyName || null,
    photo_url: p.photos?.find(x => !x.default)?.url || null,
    organization: o.name || null, job_title: o.title || null,
    emails: (p.emailAddresses || []).map(e => ({ value: e.value, type: e.type || null })),
    phones: (p.phoneNumbers || []).map(e => ({ value: e.value, type: e.type || null })) }; });
}
const demo = () => { const F = 'Rahul Ananya Arjun Priya Rohan Neha Aman Siddharth Kavya Ishaan Meera Vikram Tara Karan Diya Nikhil'.split(' '), L = 'Sharma Singh Mehta Kapoor Verma Gupta Malhotra Jain'.split(' '), O = ['Acme Technologies', 'Northwind', 'Studio Kiln', null];
  return F.flatMap((f, i) => [0, 1].map(j => { const l = L[(i + j * 3) % 8]; return { google_resource_name: `demo/${f}${j}`, name: `${f} ${l}`, first_name: f, last_name: l, photo_url: null, organization: O[(i + j) % 4], job_title: i % 3 ? 'Manager' : 'Software Engineer', emails: [{ value: `${f}.${l}@example.com`.toLowerCase(), type: 'work' }], phones: [{ value: `+91 98XXXXXX${String(10 + i * 2 + j).padStart(2, '0')}`, type: 'mobile' }] }; })); };

// ---- Contacts (identity = Google resource name, so renames keep categories)
async function allContacts(uid) {
  let out = [], f = 0;
  for (;;) {
    const { data, error } = await sb.from('contacts').select('id,name,first_name,last_name,photo_url,organization,job_title,emails,phones,created_at,last_synced_at,favorite,contact_categories(category_id)').eq('user_id', uid).order('id').range(f, f + 999);
    if (error) throw error; out.push(...(data || [])); if (!data || data.length < 1000) break; f += 1000;
  }
  return out.map(({ contact_categories: cc, ...c }) => ({ ...c, categoryId: cc?.category_id ?? cc?.[0]?.category_id ?? null }));
}
app.get('/api/contacts', auth, h(async (q, s) => s.json(await allContacts(q.uid))));
app.post('/api/contacts/sync', auth, h(async (q, s) => {
  const now = new Date().toISOString();
  const rows = (DEMO ? demo() : await googleContacts(q.uid)).map(r => ({ ...r, user_id: q.uid, last_synced_at: now }));
  for (let i = 0; i < rows.length; i += 500) { const { error } = await sb.from('contacts').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,google_resource_name' }); if (error) throw error; }
  const { error } = await sb.from('contacts').delete().eq('user_id', q.uid).lt('last_synced_at', now); if (error) throw error;
  s.json({ count: rows.length });
}));
app.put('/api/contacts/:id/category', auth, h(async (q, s) => {
  const { id } = q.params, cid = q.body.categoryId ?? null;
  if (!isId(id) || (cid !== null && !isId(cid))) throw bad('Invalid request.');
  const { data: c } = await sb.from('contacts').select('id').eq('id', id).eq('user_id', q.uid).maybeSingle();
  if (!c) throw bad('Contact not found.', 404);
  if (cid === null) { const { error } = await sb.from('contact_categories').delete().eq('contact_id', id); if (error) throw error; }
  else {
    const { data: k } = await sb.from('categories').select('id').eq('id', cid).eq('user_id', q.uid).maybeSingle();
    if (!k) throw bad('Category not found.', 404);
    const { error } = await sb.from('contact_categories').upsert({ contact_id: id, category_id: cid }); if (error) throw error;
  }
  s.status(204).end();
}));

app.put('/api/contacts/:id/favorite', auth, h(async (q, s) => {
  if (!isId(q.params.id) || typeof q.body.favorite !== 'boolean') throw bad('Invalid request.');
  const { error } = await sb.from('contacts').update({ favorite: q.body.favorite }).eq('id', q.params.id).eq('user_id', q.uid); if (error) throw error; s.status(204).end();
}));

// ---- Categories
const cols = 'id,name,color,position';
const catBody = b => { const name = String(b?.name || '').trim().slice(0, 40); if (!name) throw bad('Give the category a name.'); return { name, color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#5B5CE2' }; };
app.get('/api/categories', auth, h(async (q, s) => { const { data, error } = await sb.from('categories').select(cols).eq('user_id', q.uid).order('position').order('created_at'); if (error) throw error; s.json(data); }));
app.post('/api/categories', auth, h(async (q, s) => {
  const { count } = await sb.from('categories').select('*', { count: 'exact', head: true }).eq('user_id', q.uid);
  const { data, error } = await sb.from('categories').insert({ ...catBody(q.body), user_id: q.uid, position: count || 0 }).select(cols).single(); if (error) throw error; s.status(201).json(data);
}));
app.patch('/api/categories/:id', auth, h(async (q, s) => {
  if (!isId(q.params.id)) throw bad('Category not found.', 404);
  const { data, error } = await sb.from('categories').update({ ...catBody(q.body), updated_at: new Date() }).eq('id', q.params.id).eq('user_id', q.uid).select(cols).maybeSingle();
  if (error) throw error; if (!data) throw bad('Category not found.', 404); s.json(data);
}));
app.delete('/api/categories/:id', auth, h(async (q, s) => { // contacts stay; only the assignments go
  if (!isId(q.params.id)) throw bad('Category not found.', 404);
  const { error } = await sb.from('categories').delete().eq('id', q.params.id).eq('user_id', q.uid); if (error) throw error; s.status(204).end();
}));

app.use(express.static('public', { index: false }));
app.get(['/', '/app', '/app/*'], (q, s) => s.sendFile(path.resolve('public/index.html')));
app.use('/api', (q, s) => s.status(404).json({ error: 'Not found.' }));
app.listen(PORT, () => {
  console.log(`ContactFlow running on http://localhost:${PORT}`);
  console.log(`- Storage: ${hasSupabase ? 'Supabase (' + SUPABASE_URL + ')' : 'Local SQLite (./data/contactflow.sqlite)'}`);
  console.log(`- Auth Mode: ${DEMO ? 'Demo Mode (fake contacts)' : 'Google OAuth'}`);
});
