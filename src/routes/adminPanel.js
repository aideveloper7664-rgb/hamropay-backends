// Database admin accounts + full-data admin API
//
//   POST /admin/auth/login            admin login (DB admin, bcrypt)         -> JWT (12h)
//   GET  /admin/auth/me
//   POST /admin/auth/change-password
//   GET/POST/PATCH /admin/admins      admin accounts manage
//   GET  /admin/data/tables           saari tables + row count
//   GET  /admin/data/:table           list (limit/offset/order/dir/filter/q)
//   GET/POST/PATCH/DELETE /admin/data/:table[/:id]   read / edit / delete
//   POST /admin/data/merchants/:id/reset-password
//
// Har write admin_audit_log me likhta hai. Secrets (password hash, Gmail app password,
// Paytm merchant key) kabhi response ya audit log me plain nahi aate.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { dbAdminMiddleware } = require('../middleware/auth');

const router = express.Router();

// ---------- config ----------
// Jin tables ko admin padh/edit kar sakta hai. readonly = sirf padhna.
const TABLES = {
  merchants: {},
  wallets: {},
  hamro_credits: {},
  hamro_bonus: {},
  credit_transactions: {},
  transactions: {},
  withdrawals: {},
  orders: {},
  payment_links: {},
  checkout_sessions: {},
  cashier_accounts: {},
  settings: {},
  plans: {},
  merchant_plans: {},
  merchant_webhooks: {},
  billing_orders: {},
  platform_account: {},
  promo_codes: {},
  promo_usage: {},
  referrals: {},
  admin_audit_log: { readonly: true }
};

// In columns ki value kabhi bahar nahi jaati, aur inhe generic API se likha nahi ja sakta
const SECRET_COLUMNS = ['password', 'gmail_app_password', 'paytm_merchant_key'];
const MASK = '••••••••';
const COL_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_LIMIT = 200;
const MIN_PASSWORD = 10;

// ---------- helpers ----------
const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const fail = (res, code, message, extra = {}) => res.status(code).json({ success: false, message, ...extra });

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

function maskRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const c of SECRET_COLUMNS) if (c in out && out[c] !== null && out[c] !== '') out[c] = MASK;
  return out;
}

function getTable(req, res) {
  const name = String(req.params.table || '');
  const cfg = Object.prototype.hasOwnProperty.call(TABLES, name) ? TABLES[name] : null;
  if (!cfg) { fail(res, 404, `Unknown table "${name}"`); return null; }
  return { name, ...cfg };
}

function pkOf(req) {
  const pk = String(req.query.pk || 'id');
  return COL_RE.test(pk) ? pk : null;
}

// Primary key khud pata karo: ?pk= diya ho to wahi, warna table ka "id" (na ho to merchant_id/key/code/name)
async function resolvePk(req, table) {
  if (req.query.pk) return pkOf(req);
  try {
    const { data } = await supabase.from(table).select('*').limit(1);
    const keys = data && data[0] ? Object.keys(data[0]) : [];
    if (!keys.length || keys.includes('id')) return 'id';
    return ['merchant_id', 'key', 'code', 'name'].find((k) => keys.includes(k)) || 'id';
  } catch { return 'id'; }
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

async function audit(req, action, table, rowId, before, after) {
  try {
    const { error } = await supabase.from('admin_audit_log').insert([{
      admin_id: req.admin.aid,
      admin_email: req.admin.email,
      action,
      table_name: table,
      row_id: rowId === undefined || rowId === null ? null : String(rowId),
      before_data: before ? maskRow(before) : null,
      after_data: after ? maskRow(after) : null,
      ip: clientIp(req)
    }]);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[admin] audit log failed:', e && e.message);
    return false;
  }
}

// ---------- login rate limit (in-memory) ----------
const attempts = new Map();   // key -> { count, resetAt }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function limited(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() > a.resetAt) { attempts.delete(key); return false; }
  return a.count >= MAX_ATTEMPTS;
}
function recordFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() > a.resetAt) attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else a.count += 1;
  if (attempts.size > 2000) { for (const k of attempts.keys()) { attempts.delete(k); if (attempts.size < 1000) break; } }
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);   // email na mile tab bhi same time lage

const signToken = (admin) => jwt.sign(
  { aid: admin.id, email: admin.email, role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '12h' }
);

const publicAdmin = (a) => ({
  id: a.id, email: a.email, name: a.name || null, is_active: a.is_active,
  last_login_at: a.last_login_at || null, created_at: a.created_at
});

const strongEnough = (p) => typeof p === 'string' && p.length >= MIN_PASSWORD && p.length <= 200;

// ======================= AUTH =======================
router.post('/auth/login', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!email || !password) return fail(res, 400, 'Email and password required');

    const key = `${clientIp(req)}|${email}`;
    if (limited(key)) return fail(res, 429, 'Too many failed attempts. Try again in 15 minutes.');

    const { data: admin, error } = await supabase
      .from('admins').select('*').eq('email', email).maybeSingle();
    if (error) throw error;

    const valid = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !valid || !admin.is_active) {
      recordFail(key);
      return fail(res, 401, 'Invalid admin credentials');
    }

    attempts.delete(key);
    await supabase.from('admins').update({ last_login_at: new Date().toISOString() }).eq('id', admin.id);
    return ok(res, { token: signToken(admin), admin: publicAdmin(admin) }, { message: 'Admin login successful' });
  } catch (err) {
    console.error('[admin/login]', err && err.message);
    return fail(res, 500, 'Login failed');
  }
});

router.get('/auth/me', dbAdminMiddleware, async (req, res) => {
  const { data: admin } = await supabase.from('admins').select('*').eq('id', req.admin.aid).maybeSingle();
  return ok(res, admin ? publicAdmin(admin) : null);
});

router.post('/auth/change-password', dbAdminMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!strongEnough(new_password)) return fail(res, 400, `New password must be at least ${MIN_PASSWORD} characters`);
    const { data: admin } = await supabase.from('admins').select('*').eq('id', req.admin.aid).maybeSingle();
    if (!admin || !(await bcrypt.compare(String(current_password || ''), admin.password_hash))) {
      return fail(res, 401, 'Current password is incorrect');
    }
    const hash = await bcrypt.hash(new_password, 10);
    const { error } = await supabase.from('admins').update({ password_hash: hash }).eq('id', admin.id);
    if (error) throw error;
    await audit(req, 'admin_change_password', 'admins', admin.id, null, null);
    return ok(res, null, { message: 'Password changed' });
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// ======================= ADMIN ACCOUNTS =======================
router.get('/admins', dbAdminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('admins').select('*').order('created_at', { ascending: true });
  if (error) return fail(res, 500, error.message);
  return ok(res, (data || []).map(publicAdmin));
});

router.post('/admins', dbAdminMiddleware, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const name = req.body && req.body.name ? String(req.body.name).slice(0, 100) : null;
    const password = req.body && req.body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Valid email required');
    if (!strongEnough(password)) return fail(res, 400, `Password must be at least ${MIN_PASSWORD} characters`);

    const { data: exists } = await supabase.from('admins').select('id').eq('email', email).maybeSingle();
    if (exists) return fail(res, 400, 'Admin with this email already exists');

    const { data, error } = await supabase.from('admins')
      .insert([{ email, name, password_hash: await bcrypt.hash(password, 10), is_active: true }]).select('*').single();
    if (error) throw error;
    await audit(req, 'admin_create', 'admins', data.id, null, { id: data.id, email, name });
    return ok(res, publicAdmin(data));
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

router.patch('/admins/:id', dbAdminMiddleware, async (req, res) => {
  try {
    const patch = {};
    const b = req.body || {};
    if (b.name !== undefined) patch.name = b.name ? String(b.name).slice(0, 100) : null;
    if (b.is_active !== undefined) {
      if (req.params.id === req.admin.aid && b.is_active === false) return fail(res, 400, 'You cannot disable your own account');
      patch.is_active = !!b.is_active;
    }
    if (b.password !== undefined) {
      if (!strongEnough(b.password)) return fail(res, 400, `Password must be at least ${MIN_PASSWORD} characters`);
      patch.password_hash = await bcrypt.hash(b.password, 10);
    }
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to update');

    const { data, error } = await supabase.from('admins').update(patch).eq('id', req.params.id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'Admin not found');
    await audit(req, 'admin_update', 'admins', data.id, null, { fields: Object.keys(patch).map((k) => (k === 'password_hash' ? 'password' : k)) });
    return ok(res, publicAdmin(data));
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// ======================= DATA =======================
router.get('/data/tables', dbAdminMiddleware, async (req, res) => {
  const names = Object.keys(TABLES);
  const counts = await Promise.all(names.map(async (t) => {
    const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    return { table: t, readonly: !!TABLES[t].readonly, rows: error ? null : count, error: error ? error.message : undefined };
  }));
  return ok(res, counts);
});

const OPS = { eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', like: 'like', ilike: 'ilike', is: 'is', in: 'in' };

function applyFilters(q, req) {
  const raw = [].concat(req.query.filter || []);
  for (const f of raw) {
    const m = String(f).match(/^([a-z_][a-z0-9_]*):([a-z]+):(.*)$/s);
    if (!m || !OPS[m[2]]) throw new Error(`Bad filter "${f}". Use column:op:value (ops: ${Object.keys(OPS).join(', ')})`);
    const [, col, op, val] = m;
    if (op === 'is') q = q.is(col, val === 'null' ? null : val === 'true');
    else if (op === 'in') q = q.in(col, val.split(',').filter(Boolean));
    else q = q[OPS[op]](col, val);
  }
  if (req.query.q) {
    const cols = String(req.query.search_cols || '').split(',').filter((c) => COL_RE.test(c));
    if (!cols.length) throw new Error('search_cols required with q (comma separated column names)');
    const term = String(req.query.q).replace(/[,()%*\\]/g, ' ').trim();
    if (term) q = q.or(cols.map((c) => `${c}.ilike.%${term}%`).join(','));
  }
  return q;
}

router.get('/data/:table', dbAdminMiddleware, async (req, res) => {
  const t = getTable(req, res); if (!t) return;
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_LIMIT);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc';
    const order = req.query.order ? String(req.query.order) : 'created_at';
    if (!COL_RE.test(order)) return fail(res, 400, 'Bad order column');

    const run = (withOrder) => {
      let q = supabase.from(t.name).select('*', { count: 'exact' });
      q = applyFilters(q, req);
      if (withOrder) q = q.order(order, { ascending: dir });
      return q.range(offset, offset + limit - 1);
    };

    let { data, error, count } = await run(true);
    if (error && !req.query.order && /column .* does not exist|42703/i.test(`${error.message} ${error.code}`)) {
      ({ data, error, count } = await run(false));   // is table me created_at nahi
    }
    if (error) return fail(res, 400, error.message);
    return ok(res, (data || []).map(maskRow), { total: count, limit, offset });
  } catch (err) {
    return fail(res, 400, err.message);
  }
});

router.get('/data/:table/:id', dbAdminMiddleware, async (req, res) => {
  const t = getTable(req, res); if (!t) return;
  const pk = await resolvePk(req, t.name); if (!pk) return fail(res, 400, 'Bad pk');
  const { data, error } = await supabase.from(t.name).select('*').eq(pk, req.params.id).maybeSingle();
  if (error) return fail(res, 400, error.message);
  if (!data) return fail(res, 404, 'Row not found');
  return ok(res, maskRow(data));
});

function cleanBody(body, res, { forUpdate }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) { fail(res, 400, 'JSON object body required'); return null; }
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!COL_RE.test(k)) { fail(res, 400, `Bad column name "${k}"`); return null; }
    if (SECRET_COLUMNS.includes(k)) {
      if (forUpdate && v === MASK) continue;   // panel poori row bhejta hai: masked value ignore (badli nahi)
      fail(res, 400, `"${k}" cannot be edited here${k === 'password' ? ' (use reset-password)' : ''}`); return null;
    }
    out[k] = v;
  }
  if (!Object.keys(out).length && !forUpdate) { fail(res, 400, 'No fields provided'); return null; }
  return out;
}

router.post('/data/:table', dbAdminMiddleware, async (req, res) => {
  const t = getTable(req, res); if (!t) return;
  if (t.readonly) return fail(res, 403, `"${t.name}" is read-only`);
  const row = cleanBody(req.body, res, { forUpdate: false }); if (!row) return;
  const { data, error } = await supabase.from(t.name).insert([row]).select('*').single();
  if (error) return fail(res, 400, error.message);
  const logged = await audit(req, 'insert', t.name, data && data.id, null, data);
  return ok(res, maskRow(data), logged ? {} : { audit_warning: 'Change saved but audit log failed (run the admin SQL).' });
});

router.patch('/data/:table/:id', dbAdminMiddleware, async (req, res) => {
  const t = getTable(req, res); if (!t) return;
  if (t.readonly) return fail(res, 403, `"${t.name}" is read-only`);
  const pk = await resolvePk(req, t.name); if (!pk) return fail(res, 400, 'Bad pk');
  const sent = cleanBody(req.body, res, { forUpdate: true }); if (!sent) return;

  const { data: before, error: e1 } = await supabase.from(t.name).select('*').eq(pk, req.params.id).maybeSingle();
  if (e1) return fail(res, 400, e1.message);
  if (!before) return fail(res, 404, 'Row not found');

  // Sirf asli badlav bhejo: id / jo value same hai wo skip (poori row bhejne par bhi chale)
  const patch = {};
  for (const [k, v] of Object.entries(sent)) {
    if (k === pk || k === 'id') continue;
    if (k in before && same(v, before[k])) continue;
    patch[k] = v;
  }
  if (!Object.keys(patch).length) return ok(res, maskRow(before), { message: 'No changes to save', changed: [] });

  const { data, error } = await supabase.from(t.name).update(patch).eq(pk, req.params.id).select('*').maybeSingle();
  if (error) return fail(res, 400, error.message);
  if (!data) return fail(res, 409, 'Update did not apply (row not found or blocked by database). Nothing was changed.');
  const logged = await audit(req, 'update', t.name, req.params.id, before, data);
  return ok(res, maskRow(data), { message: 'Saved', changed: Object.keys(patch), ...(logged ? {} : { audit_warning: 'Change saved but audit log failed (run the admin SQL).' }) });
});

router.delete('/data/:table/:id', dbAdminMiddleware, async (req, res) => {
  const t = getTable(req, res); if (!t) return;
  if (t.readonly) return fail(res, 403, `"${t.name}" is read-only`);
  if (req.query.confirm !== 'yes') return fail(res, 400, 'Add ?confirm=yes to delete (this cannot be undone)');
  const pk = await resolvePk(req, t.name); if (!pk) return fail(res, 400, 'Bad pk');

  const { data: before, error: e1 } = await supabase.from(t.name).select('*').eq(pk, req.params.id).maybeSingle();
  if (e1) return fail(res, 400, e1.message);
  if (!before) return fail(res, 404, 'Row not found');

  const { error } = await supabase.from(t.name).delete().eq(pk, req.params.id);
  if (error) return fail(res, 400, error.message);
  const logged = await audit(req, 'delete', t.name, req.params.id, before, null);
  return ok(res, null, { message: 'Deleted', ...(logged ? {} : { audit_warning: 'Deleted but audit log failed (run the admin SQL).' }) });
});

router.post('/data/merchants/:id/reset-password', dbAdminMiddleware, async (req, res) => {
  try {
    const { new_password } = req.body || {};
    if (typeof new_password !== 'string' || new_password.length < 8) return fail(res, 400, 'New password must be at least 8 characters');
    const { data: m } = await supabase.from('merchants').select('id, email').eq('id', req.params.id).maybeSingle();
    if (!m) return fail(res, 404, 'Merchant not found');
    const { error } = await supabase.from('merchants').update({ password: await bcrypt.hash(new_password, 10) }).eq('id', m.id);
    if (error) throw error;
    await audit(req, 'merchant_reset_password', 'merchants', m.id, null, { email: m.email });
    return ok(res, null, { message: 'Merchant password reset' });
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// ---------- Platform FamPay account (merchants yahin payment karte hain: plan / credits) ----------
router.get('/platform-account', dbAdminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('platform_account').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return ok(res, data ? maskRow(data) : null);
  } catch (err) { return fail(res, 500, err.message); }
});

// body: { upi_id, name?, gmail_email, gmail_app_password } (app password sirf badalna ho to bhejo). Gmail login asli me check hota hai.
router.put('/platform-account', dbAdminMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const upi = String(b.upi_id || '').trim();
    const email = String(b.gmail_email || '').trim().toLowerCase();
    const pass = String(b.gmail_app_password || '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9]{2,}$/.test(upi)) return fail(res, 400, 'Enter a valid UPI ID (like 9876543210@fam)');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid Gmail address');
    const { data: cur } = await supabase.from('platform_account').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!cur && pass.length < 8) return fail(res, 400, 'Gmail App Password required');
    const { encryptSecret, decryptAppPassword } = require('../services/checkout.service');
    const { verifyGmailLogin, friendlyError } = require('../services/history.service');
    const usePass = pass.length >= 8 ? pass : decryptAppPassword(cur.gmail_app_password);
    try { await verifyGmailLogin(email, usePass); } catch (e) { return fail(res, 400, (friendlyError(e) || {}).message || 'Gmail login failed. Check email and App Password.'); }
    const row = { upi_id: upi, name: String(b.name || 'HamroPay').trim().slice(0, 40), gmail_email: email, is_active: true, ...(pass.length >= 8 ? { gmail_app_password: encryptSecret(pass) } : {}) };
    let saved;
    if (cur) {
      const { data, error } = await supabase.from('platform_account').update(row).eq('id', cur.id).select().single();
      if (error) throw error; saved = data;
    } else {
      const { data, error } = await supabase.from('platform_account').insert([{ ...row, gmail_app_password: encryptSecret(pass) }]).select().single();
      if (error) throw error; saved = data;
    }
    await audit(req, 'platform_account_set', 'platform_account', saved.id, cur, saved);
    return ok(res, maskRow(saved), { message: 'Platform payment account saved' });
  } catch (err) { return fail(res, 500, err.message); }
});

// Purane admin routes (/stats, /withdrawals, /merchants, /settings) bhi isi router se: index.js me mount alag ho ya na ho, 404 nahi aayega
try {
  const legacy = require('./admin');
  if (typeof legacy === 'function' && legacy !== router) router.use(legacy);   // admin.js galat file ho (circular) to skip, crash nahi
} catch (e) { console.error('[admin] legacy routes not loaded:', e.message); }

module.exports = router;
