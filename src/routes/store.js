// Merchant ka apna online store: products, public store page, checkout (merchant ke apne payment account me), orders.
// Payment wahi checkout engine se hoti hai jo developer orders ke liye hai (/pay/:orderId page), isliye commission,
// plan limits, auto-detect sab same chalte hain.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const P = require('../services/plans.service');
const { MAX_PAISE_SLOTS, round2, getActiveCashier, evaluateSession } = require('../services/checkout.service');

const frontendUrl = () => process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app';
const ORDER_MINUTES = 15;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const FULFIL = ['new', 'processing', 'shipped', 'delivered', 'cancelled'];

const bad = (res, msg, code = 400, extra = {}) => res.status(code).json({ success: false, message: msg, ...extra });
const isUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(String(u)).protocol) && String(u).length <= 500; } catch { return false; } };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slugify = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const orderCode = () => 'ST' + Array.from(crypto.randomBytes(6)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const sessionId = () => 'HP' + Date.now() + Array.from(crypto.randomBytes(4)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

async function myStore(merchantId) {
  const { data } = await supabase.from('stores').select('*').eq('merchant_id', merchantId).maybeSingle();
  return data || null;
}

// ======================= MERCHANT =======================

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { plan } = await P.getMerchantPlan(req.merchant.id);
    const store = await myStore(req.merchant.id);
    const { data: prods } = await supabase.from('store_products').select('id').eq('merchant_id', req.merchant.id);
    return res.json({
      success: true,
      data: store ? { ...store, url: `${frontendUrl()}/store/${store.slug}` } : null,
      usage: { products_used: (prods || []).length, products_limit: plan.store_products },
      plan: plan.name
    });
  } catch (err) { return bad(res, err.message, 500); }
});

// Store banao / badlo
router.put('/', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const name = str(b.name, 60);
    if (name.length < 2) return bad(res, 'Store name must be 2-60 characters');
    const existing = await myStore(req.merchant.id);
    const patch = { name, description: str(b.description, 500) || null };
    if (b.logo_url !== undefined) {
      if (b.logo_url && !isUrl(b.logo_url)) return bad(res, 'logo_url must be a valid http(s) URL');
      patch.logo_url = b.logo_url || null;
    }
    if (b.is_active !== undefined) patch.is_active = !!b.is_active;
    if (b.contact_phone !== undefined) patch.contact_phone = str(b.contact_phone, 20) || null;

    let slug = existing ? existing.slug : null;
    if (b.slug !== undefined || !existing) {
      slug = String(b.slug || slugify(name)).toLowerCase();
      if (!SLUG_RE.test(slug)) return bad(res, 'Store link must be 3-40 characters: letters, numbers and dashes only');
      const { data: taken } = await supabase.from('stores').select('id, merchant_id').eq('slug', slug).maybeSingle();
      if (taken && taken.merchant_id !== req.merchant.id) return bad(res, 'This store link is already taken, choose another', 409);
      patch.slug = slug;
    }

    let saved;
    if (existing) {
      const { data, error } = await supabase.from('stores').update(patch).eq('id', existing.id).select().single();
      if (error) throw error; saved = data;
    } else {
      const { data, error } = await supabase.from('stores').insert([{ merchant_id: req.merchant.id, is_active: true, ...patch }]).select().single();
      if (error) { if (error.code === '23505') return bad(res, 'This store link is already taken, choose another', 409); throw error; }
      saved = data;
    }
    return res.json({ success: true, message: 'Store saved', data: { ...saved, url: `${frontendUrl()}/store/${saved.slug}` } });
  } catch (err) { return bad(res, err.message, 500); }
});

router.get('/products', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('store_products').select('*').eq('merchant_id', req.merchant.id).order('created_at', { ascending: false });
    return res.json({ success: true, data: data || [] });
  } catch (err) { return bad(res, err.message, 500); }
});

function cleanProduct(b, plan, { partial }) {
  const out = {};
  if (!partial || b.name !== undefined) { const n = str(b.name, 100); if (n.length < 2) return { error: 'Product name must be 2-100 characters' }; out.name = n; }
  if (b.description !== undefined) out.description = str(b.description, 1000) || null;
  if (!partial || b.price !== undefined) {
    const pr = Number(b.price);
    if (!Number.isFinite(pr) || pr < 1 || round2(pr) !== pr) return { error: 'Price must be a number of at least ₹1 with max 2 decimals' };
    try { P.assertAmount(plan, pr, 'product'); } catch (e) { return { error: e.message, code: e.code }; }
    out.price = pr;
  }
  if (b.image_url !== undefined) { if (b.image_url && !isUrl(b.image_url)) return { error: 'image_url must be a valid http(s) URL' }; out.image_url = b.image_url || null; }
  if (b.stock !== undefined) {
    if (b.stock === null || b.stock === '') out.stock = null;
    else { const st = Number(b.stock); if (!Number.isInteger(st) || st < 0 || st > 1000000) return { error: 'Stock must be a whole number (or empty for unlimited)' }; out.stock = st; }
  }
  if (b.is_active !== undefined) out.is_active = !!b.is_active;
  return { value: out };
}

router.post('/products', authMiddleware, async (req, res) => {
  try {
    const store = await myStore(req.merchant.id);
    if (!store) return bad(res, 'Create your store first', 400, { code: 'NO_STORE' });
    const { plan } = await P.getMerchantPlan(req.merchant.id);
    const c = cleanProduct(req.body || {}, plan, { partial: false });
    if (c.error) return bad(res, c.error, c.code ? 403 : 400, c.code ? { code: c.code } : {});
    if (plan.store_products !== null) {
      const { data: have } = await supabase.from('store_products').select('id').eq('merchant_id', req.merchant.id);
      if ((have || []).length >= plan.store_products) return bad(res, `${plan.name} plan allows ${plan.store_products} products. Upgrade your plan to add more.`, 403, { code: 'PLAN_STORE_LIMIT' });
    }
    const { data, error } = await supabase.from('store_products').insert([{ merchant_id: req.merchant.id, store_id: store.id, is_active: true, stock: null, ...c.value }]).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (err) { return bad(res, err.message, 500); }
});

router.patch('/products/:id', authMiddleware, async (req, res) => {
  try {
    const { plan } = await P.getMerchantPlan(req.merchant.id);
    const c = cleanProduct(req.body || {}, plan, { partial: true });
    if (c.error) return bad(res, c.error, c.code ? 403 : 400, c.code ? { code: c.code } : {});
    if (!Object.keys(c.value).length) return bad(res, 'Nothing to update');
    const { data, error } = await supabase.from('store_products').update(c.value).eq('id', req.params.id).eq('merchant_id', req.merchant.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return bad(res, 'Product not found', 404);
    return res.json({ success: true, data });
  } catch (err) { return bad(res, err.message, 500); }
});

router.delete('/products/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('store_products').delete().eq('id', req.params.id).eq('merchant_id', req.merchant.id);
    return res.json({ success: true, message: 'Product deleted' });
  } catch (err) { return bad(res, err.message, 500); }
});

// ---- order status: checkout session se sync (paid hote hi stock ghatao, ek hi baar) ----
async function applyPaid(order) {
  const { data: claimed } = await supabase.from('store_orders').update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('order_code', order.order_code).eq('status', 'pending').select();
  if (!claimed || !claimed.length) return;
  for (const it of order.items || []) {
    const { data: p } = await supabase.from('store_products').select('id, stock').eq('id', it.product_id).maybeSingle();
    if (p && p.stock !== null && p.stock !== undefined) {
      await supabase.from('store_products').update({ stock: Math.max(0, Number(p.stock) - Number(it.qty)) }).eq('id', p.id);
    }
  }
}

async function syncOrder(order, { evaluate = false } = {}) {
  if (order.status !== 'pending') return order;
  const { data: s } = await supabase.from('checkout_sessions').select('*').eq('session_id', order.session_id).maybeSingle();
  if (!s) return order;
  let st = s.status;
  if (evaluate) { try { st = (await evaluateSession(s)).status; } catch { /* pending rehne do */ } }
  if (st === 'paid') { await applyPaid(order); return { ...order, status: 'paid' }; }
  if (['expired', 'cancelled', 'failed'].includes(st)) {
    await supabase.from('store_orders').update({ status: st === 'failed' ? 'cancelled' : st }).eq('order_code', order.order_code).eq('status', 'pending');
    return { ...order, status: st === 'failed' ? 'cancelled' : st };
  }
  if (new Date(s.expires_at) <= new Date()) {
    await supabase.from('store_orders').update({ status: 'expired' }).eq('order_code', order.order_code).eq('status', 'pending');
    return { ...order, status: 'expired' };
  }
  return order;
}

router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('store_orders').select('*').eq('merchant_id', req.merchant.id).order('created_at', { ascending: false }).limit(100);
    const out = [];
    for (const o of data || []) out.push(await syncOrder(o));
    return res.json({ success: true, data: out });
  } catch (err) { return bad(res, err.message, 500); }
});

// Merchant fulfilment status: new / processing / shipped / delivered / cancelled
router.patch('/orders/:code', authMiddleware, async (req, res) => {
  try {
    const f = String((req.body || {}).fulfilment || '');
    if (!FULFIL.includes(f)) return bad(res, `fulfilment must be one of: ${FULFIL.join(', ')}`);
    const { data, error } = await supabase.from('store_orders').update({ fulfilment: f, merchant_note: str((req.body || {}).note, 300) || null })
      .eq('order_code', req.params.code).eq('merchant_id', req.merchant.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return bad(res, 'Order not found', 404);
    return res.json({ success: true, data });
  } catch (err) { return bad(res, err.message, 500); }
});

// ======================= PUBLIC (customer) =======================

async function publicStore(slug) {
  const { data } = await supabase.from('stores').select('*').eq('slug', String(slug).toLowerCase()).maybeSingle();
  return data && data.is_active ? data : null;
}

router.get('/public/:slug', async (req, res) => {
  try {
    const store = await publicStore(req.params.slug);
    if (!store) return bad(res, 'Store not found', 404);
    const { data: prods } = await supabase.from('store_products').select('*').eq('store_id', store.id).eq('is_active', true).order('created_at', { ascending: false });
    const { data: m } = await supabase.from('merchants').select('name').eq('id', store.merchant_id).maybeSingle();
    return res.json({
      success: true,
      data: {
        store: { name: store.name, slug: store.slug, description: store.description, logo_url: store.logo_url, contact_phone: store.contact_phone || null, merchant_name: m ? m.name : '' },
        products: (prods || []).map((p) => ({ id: p.id, name: p.name, description: p.description, price: Number(p.price), image_url: p.image_url, in_stock: p.stock === null || p.stock === undefined || Number(p.stock) > 0, stock: p.stock === undefined ? null : p.stock }))
      }
    });
  } catch (err) { return bad(res, err.message, 500); }
});

// Checkout: { items:[{product_id, qty}], customer:{name, phone, email, address, note} }
router.post('/public/:slug/checkout', async (req, res) => {
  try {
    const store = await publicStore(req.params.slug);
    if (!store) return bad(res, 'Store not found', 404);
    const b = req.body || {};
    const cust = b.customer || {};
    const name = str(cust.name, 80);
    const phone = String(cust.phone || '').replace(/^(?:\+?91|0)/, '');
    if (name.length < 2) return bad(res, 'Please enter your name');
    if (!/^[6-9]\d{9}$/.test(phone)) return bad(res, 'Enter a valid 10-digit mobile number');
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 20) return bad(res, 'Cart must have 1-20 items');

    const m = (await supabase.from('merchants').select('*').eq('id', store.merchant_id).maybeSingle()).data;
    if (!m || m.is_active === false) return bad(res, 'Store is not available', 404);
    const { plan } = await P.getMerchantPlan(m.id);

    // Prices hamesha server se (client ki price par bharosa nahi)
    const lines = []; let total = 0;
    const seen = new Set();
    for (const it of b.items) {
      const qty = Number(it.qty);
      if (!it.product_id || seen.has(it.product_id) || !Number.isInteger(qty) || qty < 1 || qty > 50) return bad(res, 'Invalid cart item');
      seen.add(it.product_id);
      const { data: p } = await supabase.from('store_products').select('*').eq('id', it.product_id).eq('store_id', store.id).maybeSingle();
      if (!p || !p.is_active) return bad(res, 'A product in your cart is no longer available');
      if (p.stock !== null && p.stock !== undefined && Number(p.stock) < qty) return bad(res, `Only ${p.stock} left of "${p.name}"`, 409);
      lines.push({ product_id: p.id, name: p.name, price: Number(p.price), qty });
      total = round2(total + Number(p.price) * qty);
    }
    try { P.assertAmount(plan, total, 'order'); } catch (e) {
      return bad(res, 'This store cannot accept an order of this size right now. Please reduce the cart or contact the seller.', 403, { code: 'STORE_AMOUNT_LIMIT' });
    }

    const isTest = m.mode === 'test';
    if (!isTest) {
      if (process.env.MAINTENANCE_MODE === 'true') return bad(res, 'Payment system is under maintenance.', 503);
      const cashier = await getActiveCashier(m.id);
      if (!cashier) return bad(res, 'This store cannot take payments right now. Please contact the seller.', 409);
      try { P.assertAccountType(plan, cashier.type, cashier.type); } catch { return bad(res, 'This store cannot take payments right now. Please contact the seller.', 409); }
      const { data: credit } = await supabase.from('hamro_credits').select('balance').eq('merchant_id', m.id).maybeSingle();
      if (plan.commission > 0 && (!credit || credit.balance <= 0)) return bad(res, 'This store cannot take payments right now. Please contact the seller.', 409);
      await supabase.from('checkout_sessions').update({ status: 'expired' }).eq('merchant_id', m.id).eq('status', 'pending').lt('expires_at', new Date().toISOString());
    }

    const code = orderCode();
    const sid = sessionId();
    const expiresAt = new Date(Date.now() + ORDER_MINUTES * 60 * 1000).toISOString();
    const row = (payAmount) => ({
      session_id: sid, merchant_id: m.id, link_id: null, kind: 'api', base_amount: total, pay_amount: payAmount, status: 'pending',
      expires_at: expiresAt, title: `${store.name} order ${code}`.slice(0, 100),
      redirect_url: `${frontendUrl()}/store/${store.slug}?order=${code}`, customer_mobile: phone, is_test: isTest, embedded: false
    });
    let created = null;
    if (isTest) {
      const { data, error } = await supabase.from('checkout_sessions').insert([row(total)]).select().single();
      if (error) throw error; created = data;
    } else {
      for (let i = 0; i < MAX_PAISE_SLOTS; i++) {
        const { data, error } = await supabase.from('checkout_sessions').insert([row(round2(total + i * 0.01))]).select().single();
        if (!error) { created = data; break; }
        if (error.code !== '23505') throw error;
      }
      if (!created) return bad(res, 'Too many pending payments right now. Please try again in a few minutes.', 429);
    }

    const { error: oErr } = await supabase.from('store_orders').insert([{
      order_code: code, merchant_id: m.id, store_id: store.id, session_id: sid, items: lines, total,
      customer_name: name, customer_phone: phone, customer_email: str(cust.email, 120) || null,
      address: str(cust.address, 400) || null, note: str(cust.note, 300) || null, status: 'pending', fulfilment: 'new'
    }]);
    if (oErr) { await supabase.from('checkout_sessions').update({ status: 'cancelled' }).eq('session_id', sid); throw oErr; }

    return res.status(201).json({ success: true, data: { order_code: code, total, pay_amount: Number(created.pay_amount), payment_url: `${frontendUrl()}/pay/${sid}`, expires_at: created.expires_at } });
  } catch (err) { return bad(res, err.message, 500); }
});

// Customer order status (order_code anjaan aadmi guess nahi kar sakta). Yahin se payment auto-detect bhi chalta hai.
router.get('/public/:slug/order/:code', async (req, res) => {
  try {
    const store = await publicStore(req.params.slug);
    if (!store) return bad(res, 'Store not found', 404);
    const { data: o } = await supabase.from('store_orders').select('*').eq('order_code', String(req.params.code)).eq('store_id', store.id).maybeSingle();
    if (!o) return bad(res, 'Order not found', 404);
    const f = await syncOrder(o, { evaluate: true });
    const { data: fresh } = await supabase.from('store_orders').select('*').eq('order_code', o.order_code).maybeSingle();
    const x = fresh || f;
    return res.json({ success: true, data: { order_code: x.order_code, status: x.status, fulfilment: x.fulfilment, items: x.items, total: Number(x.total), customer_name: x.customer_name, created_at: x.created_at, paid_at: x.paid_at || null, payment_url: x.status === 'pending' ? `${frontendUrl()}/pay/${x.session_id}` : null } });
  } catch (err) { return bad(res, err.message, 500); }
});

module.exports = router;
