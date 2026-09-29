import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

export function createLocalClient(dbPath = './data/contactflow.sqlite') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT,
      name TEXT,
      avatar_url TEXT,
      google_refresh_token TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#5B5CE2',
      position INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      google_resource_name TEXT NOT NULL,
      name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      photo_url TEXT,
      organization TEXT,
      job_title TEXT,
      emails TEXT NOT NULL DEFAULT '[]',
      phones TEXT NOT NULL DEFAULT '[]',
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, google_resource_name)
    );

    CREATE TABLE IF NOT EXISTS contact_categories (
      contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  function filterFields(obj, fieldsStr) {
    if (!obj || !fieldsStr || fieldsStr === '*') return obj;
    const fields = fieldsStr.split(',').map(f => f.trim());
    const res = {};
    for (const f of fields) {
      if (f in obj) res[f] = obj[f];
    }
    return res;
  }

  function queryBuilder(table) {
    let mode = 'select'; // 'select', 'insert', 'upsert', 'update', 'delete'
    let selectFields = '*';
    let selectOpts = {};
    let insertData = null;
    let updateData = null;
    let upsertOpts = null;
    let whereClauses = [];
    let orderClauses = [];
    let limitVal = null;
    let offsetVal = null;

    const builder = {
      select(fields = '*', opts = {}) {
        if (mode === 'select') {
          // If we haven't started an insert/upsert/update, we remain in select mode
          selectFields = fields;
          selectOpts = opts;
        } else {
          // If we are chaining .select() after .insert() / .upsert() / .update(), just store the fields to return
          selectFields = fields;
          selectOpts = opts;
        }
        return builder;
      },

      insert(data) {
        mode = 'insert';
        insertData = data;
        return builder;
      },

      upsert(data, opts = {}) {
        mode = 'upsert';
        insertData = data;
        upsertOpts = opts;
        return builder;
      },

      update(data) {
        mode = 'update';
        updateData = data;
        return builder;
      },

      delete() {
        mode = 'delete';
        return builder;
      },

      eq(col, val) {
        whereClauses.push({ col, op: '=', val });
        return builder;
      },

      lt(col, val) {
        whereClauses.push({ col, op: '<', val });
        return builder;
      },

      order(col, opts = {}) {
        const dir = (opts && opts.ascending === false) ? 'DESC' : 'ASC';
        orderClauses.push({ col, dir });
        return builder;
      },

      range(from, to) {
        offsetVal = from;
        limitVal = to - from + 1;
        return builder;
      },

      async single() {
        const res = await builder._execute();
        if (res.error) return res;
        const row = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
        if (!row) {
          return { data: null, error: new Error('No rows found') };
        }
        return { data: row, error: null };
      },

      async maybeSingle() {
        const res = await builder._execute();
        if (res.error) return res;
        const row = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
        return { data: row, error: null };
      },

      then(resolve, reject) {
        return builder._execute().then(resolve, reject);
      },

      async _execute() {
        try {
          if (mode === 'select') {
            if (selectOpts && selectOpts.head && selectOpts.count === 'exact') {
              let sql = `SELECT COUNT(*) as cnt FROM ${table}`;
              const params = [];
              if (whereClauses.length > 0) {
                sql += ' WHERE ' + whereClauses.map(w => {
                  params.push(w.val);
                  return `${w.col} ${w.op} ?`;
                }).join(' AND ');
              }
              const row = db.prepare(sql).get(...params);
              return { count: row ? Number(row.cnt) : 0, data: null, error: null };
            }

            if (table === 'contacts' && selectFields.includes('contact_categories')) {
              let sql = `
                SELECT c.id, c.name, c.first_name, c.last_name, c.photo_url, c.organization, c.job_title,
                       c.emails, c.phones, c.created_at, c.last_synced_at, c.favorite,
                       cc.category_id
                FROM contacts c
                LEFT JOIN contact_categories cc ON cc.contact_id = c.id
              `;
              const params = [];
              if (whereClauses.length > 0) {
                sql += ' WHERE ' + whereClauses.map(w => {
                  params.push(w.val);
                  const col = w.col === 'user_id' ? 'c.user_id' : (w.col === 'id' ? 'c.id' : w.col);
                  return `${col} ${w.op} ?`;
                }).join(' AND ');
              }
              if (orderClauses.length > 0) {
                sql += ' ORDER BY ' + orderClauses.map(o => `c.${o.col} ${o.dir}`).join(', ');
              }
              if (limitVal !== null) {
                sql += ` LIMIT ${limitVal}`;
                if (offsetVal !== null) {
                  sql += ` OFFSET ${offsetVal}`;
                }
              }
              const rows = db.prepare(sql).all(...params);
              const data = rows.map(r => ({
                id: r.id,
                name: r.name,
                first_name: r.first_name,
                last_name: r.last_name,
                photo_url: r.photo_url,
                organization: r.organization,
                job_title: r.job_title,
                emails: typeof r.emails === 'string' ? JSON.parse(r.emails) : (r.emails || []),
                phones: typeof r.phones === 'string' ? JSON.parse(r.phones) : (r.phones || []),
                favorite: Boolean(r.favorite),
                created_at: r.created_at,
                last_synced_at: r.last_synced_at,
                contact_categories: r.category_id ? { category_id: r.category_id } : null
              }));
              return { data, error: null };
            }

            let sql = `SELECT * FROM ${table}`;
            const params = [];
            if (whereClauses.length > 0) {
              sql += ' WHERE ' + whereClauses.map(w => {
                params.push(w.val);
                return `${w.col} ${w.op} ?`;
              }).join(' AND ');
            }
            if (orderClauses.length > 0) {
              sql += ' ORDER BY ' + orderClauses.map(o => `${o.col} ${o.dir}`).join(', ');
            }
            if (limitVal !== null) {
              sql += ` LIMIT ${limitVal}`;
              if (offsetVal !== null) {
                sql += ` OFFSET ${offsetVal}`;
              }
            }
            const rows = db.prepare(sql).all(...params);
            const data = rows.map(r => {
              if (table === 'contacts') {
                if (typeof r.emails === 'string') r.emails = JSON.parse(r.emails);
                if (typeof r.phones === 'string') r.phones = JSON.parse(r.phones);
                if ('favorite' in r) r.favorite = Boolean(r.favorite);
              }
              return filterFields(r, selectFields);
            });
            return { data, error: null };
          }

          if (mode === 'insert') {
            const row = { ...insertData };
            if (!row.id) row.id = crypto.randomUUID();
            const now = new Date().toISOString();
            if (!row.created_at) row.created_at = now;
            if (!row.updated_at) row.updated_at = now;

            if (table === 'categories') {
              db.prepare(`
                INSERT INTO categories (id, user_id, name, color, position, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).run(row.id, row.user_id, row.name, row.color || '#5B5CE2', row.position || 0, row.created_at, row.updated_at);
              return { data: filterFields(row, selectFields), error: null };
            }

            const keys = Object.keys(row);
            const vals = keys.map(k => {
              const v = row[k];
              return (typeof v === 'object' && v !== null && !(v instanceof Date)) ? JSON.stringify(v) : v;
            });
            const placeholders = keys.map(() => '?').join(', ');
            db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`).run(...vals);
            return { data: filterFields(row, selectFields), error: null };
          }

          if (mode === 'upsert') {
            const items = Array.isArray(insertData) ? insertData : [insertData];
            let lastRow = null;

            for (const item of items) {
              const row = { ...item };
              const now = new Date().toISOString();

              if (table === 'users') {
                const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(row.google_id);
                if (existing) {
                  db.prepare(`
                    UPDATE users SET
                      email = coalesce(?, email),
                      name = coalesce(?, name),
                      avatar_url = coalesce(?, avatar_url),
                      google_refresh_token = coalesce(?, google_refresh_token),
                      updated_at = ?
                    WHERE google_id = ?
                  `).run(row.email ?? null, row.name ?? null, row.avatar_url ?? null, row.google_refresh_token ?? null, now, row.google_id);
                  lastRow = db.prepare('SELECT * FROM users WHERE google_id = ?').get(row.google_id);
                } else {
                  row.id = row.id || crypto.randomUUID();
                  db.prepare(`
                    INSERT INTO users (id, google_id, email, name, avatar_url, google_refresh_token, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  `).run(row.id, row.google_id, row.email ?? null, row.name ?? null, row.avatar_url ?? null, row.google_refresh_token ?? null, now, now);
                  lastRow = row;
                }
              } else if (table === 'contacts') {
                const existing = db.prepare('SELECT id, created_at, favorite FROM contacts WHERE user_id = ? AND google_resource_name = ?').get(row.user_id, row.google_resource_name);
                const emailsStr = JSON.stringify(row.emails || []);
                const phonesStr = JSON.stringify(row.phones || []);
                const syncAt = row.last_synced_at || now;

                if (existing) {
                  db.prepare(`
                    UPDATE contacts SET
                      name = ?,
                      first_name = ?,
                      last_name = ?,
                      photo_url = ?,
                      organization = ?,
                      job_title = ?,
                      emails = ?,
                      phones = ?,
                      last_synced_at = ?
                    WHERE user_id = ? AND google_resource_name = ?
                  `).run(
                    row.name,
                    row.first_name ?? null,
                    row.last_name ?? null,
                    row.photo_url ?? null,
                    row.organization ?? null,
                    row.job_title ?? null,
                    emailsStr,
                    phonesStr,
                    syncAt,
                    row.user_id,
                    row.google_resource_name
                  );
                } else {
                  row.id = row.id || crypto.randomUUID();
                  db.prepare(`
                    INSERT INTO contacts (
                      id, user_id, google_resource_name, name, first_name, last_name,
                      photo_url, organization, job_title, emails, phones, favorite,
                      created_at, last_synced_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                  `).run(
                    row.id,
                    row.user_id,
                    row.google_resource_name,
                    row.name,
                    row.first_name ?? null,
                    row.last_name ?? null,
                    row.photo_url ?? null,
                    row.organization ?? null,
                    row.job_title ?? null,
                    emailsStr,
                    phonesStr,
                    now,
                    syncAt
                  );
                }
              } else if (table === 'contact_categories') {
                db.prepare(`
                  INSERT INTO contact_categories (contact_id, category_id, created_at)
                  VALUES (?, ?, ?)
                  ON CONFLICT(contact_id) DO UPDATE SET category_id = excluded.category_id
                `).run(row.contact_id, row.category_id, now);
              }
            }

            return { data: Array.isArray(insertData) ? null : filterFields(lastRow, selectFields), error: null };
          }

          if (mode === 'update') {
            const updates = { ...updateData };
            const setCols = [];
            const params = [];
            for (const [k, v] of Object.entries(updates)) {
              setCols.push(`${k} = ?`);
              if (table === 'contacts' && k === 'favorite') {
                params.push(v ? 1 : 0);
              } else if (v instanceof Date) {
                params.push(v.toISOString());
              } else {
                params.push(v);
              }
            }

            let sql = `UPDATE ${table} SET ${setCols.join(', ')}`;
            if (whereClauses.length > 0) {
              sql += ' WHERE ' + whereClauses.map(w => {
                params.push(w.val);
                return `${w.col} ${w.op} ?`;
              }).join(' AND ');
            }
            db.prepare(sql).run(...params);

            // If select fields are requested, return updated row
            if (selectFields && whereClauses.length > 0) {
              let selectSql = `SELECT * FROM ${table} WHERE ` + whereClauses.map(w => `${w.col} ${w.op} ?`).join(' AND ');
              const selectParams = whereClauses.map(w => w.val);
              const updatedRow = db.prepare(selectSql).get(...selectParams);
              return { data: updatedRow ? filterFields(updatedRow, selectFields) : null, error: null };
            }

            return { data: null, error: null };
          }

          if (mode === 'delete') {
            let sql = `DELETE FROM ${table}`;
            const params = [];
            if (whereClauses.length > 0) {
              sql += ' WHERE ' + whereClauses.map(w => {
                params.push(w.val);
                return `${w.col} ${w.op} ?`;
              }).join(' AND ');
            }
            db.prepare(sql).run(...params);
            return { data: null, error: null };
          }
        } catch (err) {
          return { data: null, error: err };
        }
      }
    };

    return builder;
  }

  return {
    from(table) {
      return queryBuilder(table);
    },
    close() {
      db.close();
    }
  };
}
