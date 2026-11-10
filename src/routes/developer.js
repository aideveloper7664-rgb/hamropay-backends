const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { resolveBranding } = require('../services/themes');
const { MAX_PAISE_SLOTS, round2, getActiveCashier, evaluateSession } = require('../services/checkout.service');

const ORDER_MINUTES = 15;                                         // developer order kitni der valid rahe
const MIN_AMOUNT = 1;
const MAX_AMOUNT = Number(process.env.MAX_ORDER_AMOUNT) || 5000;
const RATE_LIMIT = 60;                                            // requests
const RATE_WINDOW_MS = 15 * 60 * 1000;                            // per 15 minutes, per API key (key na ho to IP)
const frontendUrl = () => process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app';

// ======================= helpers =======================
const hits = new Map();
function rateLimited(bucket) {
  const now = Date.now();
  if (hits.size > 5000) { for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }
  let e = hits.get(bucket);
  if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + RATE_WINDOW_MS }; hits.set(bucket, e); }
  e.count += 1;
  return e.count > RATE_LIMIT;
}

// Developer API auth: key body me "hamro_api" ya header "X-HamroAPI-Key" (purana "x-api-key" bhi chalega)
async function devAuth(req, res, next) {
  try {
    const key = (req.body && typeof req.body.hamro_api === 'string' && req.body.hamro_api) ||
                req.headers['x-hamroapi-key'] || req.headers['x-api-key'] || null;

    if (rateLimited(key ? 'k:' + key : 'ip:' + req.ip)) {
      return res.status(429).json({ success: false, message: 'Too many API requests. Please try again later.' });
    }
    if (!key) {
      return res.status(401).json({ success: false, message: 'Missing HamroAPI key. Pass it as "hamro_api" in the request body or an "X-HamroAPI-Key" header.' });
    }

    const { data: merchant } = await supabase.from('merchants').select('*').eq('api_key', String(key)).maybeSingle();
    if (!merchant) return res.status(401).json({ success: false, message: 'Invalid HamroAPI key' });
    if (merchant.is_active === false) {
      return res.status(403).json({ success: false, message: 'This account has been suspended.', banned: true });
    }
    req.merchant = merchant;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function genOrderId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = Array.from(crypto.randomBytes(4)).map((b) => alphabet[b % alphabet.length]).join('');
  return 'HP' + Date.now() + rand;
}

function validateCreateOrder(body) {
  const errors = [];
  const out = {};

  // amount: clean number (ya "499" jaisi clean string). "₹499" / "1,999" reject.
  let n = NaN;
  if (typeof body.amount === 'number') n = body.amount;
  else if (typeof body.amount === 'string' && /^\d+(\.\d{1,2})?$/.test(body.amount.trim())) n = Number(body.amount.trim());
  if (!Number.isFinite(n) || n < MIN_AMOUNT || n > MAX_AMOUNT) {
    errors.push({ field: 'amount', msg: `Amount must be a plain number between ₹${MIN_AMOUNT} and ₹${MAX_AMOUNT.toLocaleString('en-IN')}` });
  } else if (round2(n) !== n) {
    errors.push({ field: 'amount', msg: 'Amount can have at most 2 decimal places' });
  } else out.amount = n;

  if (body.title !== undefined && body.title !== null && body.title !== '') {
    if (typeof body.title !== 'string' || body.title.length > 100) errors.push({ field: 'title', msg: 'Title must be a string of at most 100 characters' });
    else out.title = body.title.trim();
  }

  if (body.customer_mobile !== undefined && body.customer_mobile !== null && body.customer_mobile !== '') {
    if (typeof body.customer_mobile !== 'string' || !/^(?:\+?91|0)?[6-9]\d{9}$/.test(body.customer_mobile)) {
      errors.push({ field: 'customer_mobile', msg: 'Mobile must be exactly 10 digits (optionally prefixed with 91, +91 or 0), no spaces or symbols' });
    } else out.customerMobile = body.customer_mobile.replace(/^(?:\+?91|0)/, '');
  }

  if (body.redirect_url !== undefined && body.redirect_url !== null && body.redirect_url !== '') {
    let ok = false;
    try {
      const u = new URL(String(body.redirect_url));
      ok = ['http:', 'https:'].includes(u.protocol) && String(body.redirect_url).length <= 500;
    } catch { ok = false; }
    if (!ok) errors.push({ field: 'redirect_url', msg: 'redirect_url must be a valid http(s) URL (max 500 characters)' });
    else out.redirectUrl = String(body.redirect_url);
  }

  if (body.useEmbedded !== undefined && body.useEmbedded !== null) {
    if (typeof body.useEmbedded !== 'boolean') errors.push({ field: 'useEmbedded', msg: 'useEmbedded must be true or false' });
    else out.embedded = body.useEmbedded;
  }

  return { errors, value: out };
}

// Internal session status -> public API status (hamesha: pending | success | failed)
function toApiStatus(internal) {
  switch (internal) {
    case 'paid': return { status: 'success' };
    case 'pending': return { status: 'pending' };
    case 'expired': return { status: 'failed', reason: 'timeout' };
    case 'cancelled': return { status: 'failed', reason: 'cancelled' };
    case 'failed': return { status: 'failed', reason: 'processing_failed' };
    default: return { status: 'failed', reason: 'unavailable' };
  }
}

async function findApiOrder(orderId, merchantId = null) {
  let q = supabase.from('checkout_sessions').select('*').eq('session_id', String(orderId)).eq('kind', 'api');
  if (merchantId) q = q.eq('merchant_id', merchantId);
  const { data } = await q.maybeSingle();
  return data || null;
}

// ======================= DEVELOPER API =======================

// Create order
router.post('/create-order', devAuth, async (req, res) => {
  try {
    const v = validateCreateOrder(req.body || {});
    if (v.errors.length) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: v.errors });
    }
    const { amount, title, customerMobile, redirectUrl, embedded } = v.value;
    const m = req.merchant;
    const isTest = m.mode === 'test';

    if (!isTest) {
      if (process.env.MAINTENANCE_MODE === 'true') {
        return res.status(503).json({ success: false, message: 'Payment system is under maintenance.' });
      }

      const cashier = await getActiveCashier(m.id);
      if (!cashier) {
        return res.status(400).json({ success: false, message: 'Please connect FamPay or Paytm account first to accept payments' });
      }

      const { data: credit } = await supabase.from('hamro_credits').select('balance').eq('merchant_id', m.id).maybeSingle();
      if (!credit || credit.balance <= 0) {
        return res.status(400).json({ success: false, message: 'Insufficient Hamro Credits. Please purchase more credits.' });
      }

      // Expire ho chuke pending orders ke amount free karo
      await supabase.from('checkout_sessions').update({ status: 'expired' })
        .eq('merchant_id', m.id).eq('status', 'pending').lt('expires_at', new Date().toISOString());
    }

    const expiresAt = new Date(Date.now() + ORDER_MINUTES * 60 * 1000).toISOString();
    const orderId = genOrderId();
    const row = (payAmount) => ({
      session_id: orderId,
      merchant_id: m.id,
      link_id: null,
      kind: 'api',
      base_amount: amount,
      pay_amount: payAmount,
      status: 'pending',
      expires_at: expiresAt,
      title: title || 'Hamro Pay Payment',
      redirect_url: redirectUrl || null,
      customer_mobile: customerMobile || null,
      is_test: isTest,
      embedded: !!embedded
    });

    let created = null;
    if (isTest) {
      // Test order: unique paise ki zarurat nahi, koi asli payment nahi hoti
      const { data, error } = await supabase.from('checkout_sessions').insert([row(amount)]).select().single();
      if (error) throw error;
      created = data;
    } else {
      for (let i = 0; i < MAX_PAISE_SLOTS; i++) {
        const { data, error } = await supabase.from('checkout_sessions').insert([row(round2(amount + i * 0.01))]).select().single();
        if (!error) { created = data; break; }
        if (error.code !== '23505') throw error;   // 23505 = ye amount abhi kisi aur pending order ke paas hai
      }
      if (!created) {
        return res.status(429).json({ success: false, message: 'Too many pending orders right now. Please try again in a few minutes.' });
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Order created',
      data: {
        order_id: created.session_id,
        payment_url: `${frontendUrl()}/pay/${created.session_id}${embedded ? '?embedded=1' : ''}`,
        amount,
        pay_amount: Number(created.pay_amount),
        expires_at: created.expires_at,
        mode: isTest ? 'test' : 'live'
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get order status (server-to-server verification)
router.get('/order-status/:orderId', devAuth, async (req, res) => {
  try {
    const s = await findApiOrder(req.params.orderId, req.merchant.id);
    if (!s) return res.status(404).json({ success: false, message: 'Order not found' });

    const r = await evaluateSession(s);
    const api = toApiStatus(r.status);

    return res.json({
      success: true,
      message: 'Status fetched',
      data: {
        order_id: s.session_id,
        status: api.status,
        ...(api.reason ? { reason: api.reason } : {}),
        amount: Number(s.base_amount),
        pay_amount: Number(s.pay_amount),
        ...(api.status === 'success' ? { utr: r.utr } : {}),
        mode: s.is_test ? 'test' : 'live'
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ======================= PUBLIC (customer pay page / widget) =======================

// Pay page ko order ki details
router.get('/public-order/:orderId', async (req, res) => {
  try {
    const s = await findApiOrder(req.params.orderId);
    if (!s) return res.status(404).json({ success: false, message: 'Order not found' });

    let status = s.status;
    if (status === 'pending' && new Date(s.expires_at) <= new Date()) status = 'expired';

    const { data: merchant } = await supabase.from('merchants').select('*').eq('id', s.merchant_id).maybeSingle();

    const data = {
      order_id: s.session_id,
      title: s.title || 'Hamro Pay Payment',
      amount: Number(s.base_amount),
      pay_amount: Number(s.pay_amount),
      status,
      merchant_name: (merchant && merchant.name) || '',
      branding: resolveBranding(merchant),
      is_test: !!s.is_test,
      embedded: !!s.embedded,
      expires_at: s.expires_at,
      server_time: new Date().toISOString(),
      redirect_url: s.redirect_url || null
    };

    // UPI / QR sirf live aur pending order ke liye
    if (!s.is_test && status === 'pending') {
      const cashier = await getActiveCashier(s.merchant_id);
      if (!cashier) return res.status(409).json({ success: false, message: 'Merchant has no active payment account' });
      data.upi_id = cashier.upi_id;
      data.qr_code = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=${encodeURIComponent(`upi://pay?pa=${cashier.upi_id}&pn=Payment&am=${Number(s.pay_amount).toFixed(2)}&cu=INR`)}`;
    }

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Page / widget har ~3 second me ye poochta hai (payment mile to backend khud confirm kar deta hai)
router.get('/public-order-status/:orderId', async (req, res) => {
  try {
    const s = await findApiOrder(req.params.orderId);
    if (!s) return res.status(404).json({ success: false, message: 'Order not found' });

    const r = await evaluateSession(s);

    return res.json({
      success: true,
      data: {
        status: r.status,                       // pending | paid | expired | cancelled | failed | disabled
        order_id: s.session_id,
        amount: Number(s.base_amount),
        pay_amount: Number(s.pay_amount),
        expires_at: s.expires_at,
        server_time: new Date().toISOString(),
        utr: r.status === 'paid' ? r.utr : null,
        is_test: !!s.is_test,
        ...r.extra
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Customer "Cancel payment"
router.post('/public-cancel/:orderId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('checkout_sessions')
      .update({ status: 'cancelled' })
      .eq('session_id', String(req.params.orderId))
      .eq('kind', 'api')
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (error) throw error;
    return res.json({ success: true, data: { cancelled: !!data } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Test mode simulator: Successfully / Failed / Cancelled (sirf test orders par, koi paisa nahi hilta)
router.post('/test-action/:orderId', async (req, res) => {
  try {
    const action = req.body && req.body.action;
    if (!['success', 'failed', 'cancelled'].includes(action)) {
      return res.status(400).json({ success: false, message: "action must be 'success', 'failed' or 'cancelled'" });
    }

    const s = await findApiOrder(req.params.orderId);
    if (!s) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!s.is_test) return res.status(403).json({ success: false, message: 'Simulator works on test-mode orders only' });
    if (s.status !== 'pending') return res.status(400).json({ success: false, message: 'This order is already completed' });
    if (new Date(s.expires_at) <= new Date()) return res.status(400).json({ success: false, message: 'This order has expired' });

    const patch = action === 'success'
      ? { status: 'paid', utr: 'TEST' + Date.now(), order_id: s.session_id, paid_at: new Date().toISOString() }
      : { status: action };

    const { data: updated } = await supabase
      .from('checkout_sessions')
      .update(patch)
      .eq('session_id', s.session_id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (!updated) return res.status(400).json({ success: false, message: 'This order is already completed' });

    if (action === 'success') {
      const { data: merchant } = await supabase.from('merchants').select('webhook_url').eq('id', s.merchant_id).maybeSingle();
      if (merchant && merchant.webhook_url) {
        fetch(merchant.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'payment.test', test: true, order_id: s.session_id, link_id: null, utr: patch.utr, amount: Number(s.base_amount) })
        }).catch(() => {});
      }
    }

    return res.json({ success: true, data: { order_id: s.session_id, status: action === 'success' ? 'paid' : action } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ======================= MERCHANT DASHBOARD (x-api-key) =======================

// Get API token info
router.get('/token', authMiddleware, async (req, res) => {
  try {
    return res.json({
      success: true,
      data: {
        api_key: req.merchant.api_key,
        created_at: req.merchant.created_at,
        mode: req.merchant.mode || 'live'
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Regenerate API key (purani key turant band ho jaati hai)
router.post('/token/regenerate', authMiddleware, async (req, res) => {
  try {
    const newKey = 'hmpay_' + uuidv4().replace(/-/g, '');

    const { error } = await supabase
      .from('merchants')
      .update({ api_key: newKey })
      .eq('id', req.merchant.id);

    if (error) throw error;

    return res.json({ success: true, data: { api_key: newKey } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Set mode (live/test): account-wide, create-order aur sab developer orders par lagu
router.post('/mode', authMiddleware, async (req, res) => {
  try {
    const { mode } = req.body;

    if (!['live', 'test'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Mode must be live or test' });
    }

    const { error } = await supabase
      .from('merchants')
      .update({ mode })
      .eq('id', req.merchant.id);
    if (error) throw error;

    return res.json({ success: true, message: `Mode set to ${mode}`, data: { mode } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get webhooks
router.get('/webhooks', authMiddleware, async (req, res) => {
  try {
    return res.json({
      success: true,
      data: req.merchant.webhook_url
        ? [{ url: req.merchant.webhook_url, events: ['payment.success', 'payment.test'] }]
        : []
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Add/Update webhook
router.post('/webhooks', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, message: 'Webhook URL required' });
    }
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(String(url)).protocol); } catch { ok = false; }
    if (!ok) {
      return res.status(400).json({ success: false, message: 'Webhook URL must be a valid http(s) URL' });
    }

    await supabase
      .from('merchants')
      .update({ webhook_url: String(url) })
      .eq('id', req.merchant.id);

    return res.json({ success: true, message: 'Webhook updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Delete webhook
router.delete('/webhooks', authMiddleware, async (req, res) => {
  try {
    await supabase
      .from('merchants')
      .update({ webhook_url: null })
      .eq('id', req.merchant.id);

    return res.json({ success: true, message: 'Webhook removed' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get API orders (saare statuses: pending / success / failed)
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('checkout_sessions')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .eq('kind', 'api')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const now = Date.now();
    const orders = (data || []).map((s) => {
      const internal = s.status === 'pending' && new Date(s.expires_at).getTime() <= now ? 'expired' : s.status;
      const api = toApiStatus(internal);
      return {
        id: s.id,
        order_id: s.session_id,
        title: s.title,
        amount: Number(s.base_amount),
        pay_amount: Number(s.pay_amount),
        status: api.status,
        reason: api.reason || null,
        utr: s.utr || null,
        mode: s.is_test ? 'test' : 'live',
        created_at: s.created_at
      };
    });

    return res.json({ success: true, data: orders });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
