// Merchant -> HamroPay payments (plan kharidna / Hamro Credits kharidna).
// Paisa admin ke FamPay UPI me aata hai (table platform_account). Har order ka alag, unique amount (paise) hota hai,
// aur admin Gmail me FamPay email se payment auto-detect hoti hai. Payment mili tabhi plan/credits milte hain.
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const history = require('../services/history.service');
const { decryptAppPassword, round2, MAX_PAISE_SLOTS } = require('../services/checkout.service');
const P = require('../services/plans.service');

const ORDER_MINUTES = 15;
const MIN_CREDITS = 10;
const MAX_CREDITS = 10000;

async function getPlatformAccount() {
  const { data } = await supabase.from('platform_account').select('*').eq('is_active', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

const upiUri = (acct, amount, orderId) =>
  `upi://pay?pa=${acct.upi_id}&pn=${encodeURIComponent(acct.name || 'HamroPay')}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(orderId)}`;

function view(o, acct) {
  const d = {
    order_id: o.order_id, kind: o.kind, plan_name: o.plan_name || null, credits: o.credits || null,
    base_amount: Number(o.base_amount), pay_amount: Number(o.pay_amount), status: o.status,
    expires_at: o.expires_at, server_time: new Date().toISOString(), fulfilled: !!o.fulfilled
  };
  if (o.status === 'pending' && acct) {
    d.upi_id = acct.upi_id;
    d.upi_uri = upiUri(acct, o.pay_amount, o.order_id);
    d.qr_code = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=${encodeURIComponent(d.upi_uri)}`;
  }
  return d;
}

// ---- payment mil gayi: ek hi baar fulfil (atomic claim) ----
async function fulfil(o) {
  const { data: claimed } = await supabase.from('billing_orders').update({ fulfilled: true })
    .eq('order_id', o.order_id).eq('fulfilled', false).select();
  if (!claimed || !claimed.length) return;           // koi aur request fulfil kar chuki
  try {
    if (o.kind === 'plan') {
      await P.activatePlan(o.merchant_id, P.lookup(o.plan_name));
    } else {
      const credits = Number(o.credits);
      const { data: credit } = await supabase.from('hamro_credits').select('balance, total_purchased').eq('merchant_id', o.merchant_id).maybeSingle();
      const first = !credit || (Number(credit.total_purchased) || 0) === 0;
      if (credit) {
        await supabase.from('hamro_credits').update({
          balance: round2(Number(credit.balance) + credits), total_purchased: round2((Number(credit.total_purchased) || 0) + credits), updated_at: new Date().toISOString()
        }).eq('merchant_id', o.merchant_id);
      } else {
        await supabase.from('hamro_credits').insert([{ merchant_id: o.merchant_id, balance: 20 + credits, total_purchased: credits, total_spent: 0 }]);
      }
      await supabase.from('credit_transactions').insert([{ merchant_id: o.merchant_id, type: 'purchase', amount: credits, utr: o.utr, order_id: o.order_id, note: `Purchased ${credits} Hamro Credits` }]);
      if (first) { try { await require('./referral').processReferralCashback(o.merchant_id, credits); } catch (e) { console.error('[billing] referral:', e.message); } }
    }
  } catch (e) {
    // fulfil fail hua: flag wapas, agle status check par dobara try hoga
    console.error('[billing] fulfil failed:', e && e.message);
    await supabase.from('billing_orders').update({ fulfilled: false }).eq('order_id', o.order_id);
  }
}

// Admin Gmail scan -> is order ka payment mila? (utrHint ho to wahi UTR chahiye)
async function evaluate(o, acct, utrHint = null) {
  if (o.status === 'paid') { if (!o.fulfilled) await fulfil(o); return o.status; }
  if (o.status !== 'pending') return o.status;
  if (new Date(o.expires_at) <= new Date()) {
    await supabase.from('billing_orders').update({ status: 'expired' }).eq('order_id', o.order_id).eq('status', 'pending');
    return 'expired';
  }
  if (!acct || !acct.gmail_email || !acct.gmail_app_password) return 'pending';

  let scan;
  try {
    scan = await history.getFamPayHistory(`platform:${acct.id}`, {
      email: acct.gmail_email, appPassword: decryptAppPassword(acct.gmail_app_password),
      days: 2, limit: 30, ttlMs: 5000, provider: 'fampay'
    });
  } catch (e) {
    console.error('[billing] gmail error:', e && e.message);
    return 'pending';
  }
  const minTs = new Date(o.created_at).getTime() - 2 * 60 * 1000;
  const cands = scan.transactions.filter((t) =>
    t.reference && Math.abs(t.amount - Number(o.pay_amount)) < 0.005 &&
    (t.mail_date || t.date) && new Date(t.mail_date || t.date).getTime() >= minTs &&
    (!utrHint || String(t.reference).toLowerCase() === String(utrHint).toLowerCase()));

  for (const t of cands) {
    const [{ data: u1 }, { data: u2 }] = await Promise.all([
      supabase.from('billing_orders').select('id').eq('utr', t.reference).maybeSingle(),
      supabase.from('credit_transactions').select('id').eq('utr', t.reference).maybeSingle()
    ]);
    if (u1 || u2) continue;                                   // ye UTR pehle use ho chuka
    const { data: claimed } = await supabase.from('billing_orders')
      .update({ status: 'paid', utr: t.reference, paid_at: new Date().toISOString() })
      .eq('order_id', o.order_id).eq('status', 'pending').select();
    if (!claimed || !claimed.length) { const { data: f } = await supabase.from('billing_orders').select('*').eq('order_id', o.order_id).maybeSingle(); return f ? f.status : 'pending'; }
    await fulfil({ ...o, ...claimed[0] });
    return 'paid';
  }
  return 'pending';
}

async function mine(req) {
  const { data } = await supabase.from('billing_orders').select('*').eq('order_id', String(req.params.orderId || req.body.order_id || '')).eq('merchant_id', req.merchant.id).maybeSingle();
  return data;
}

// Naya payment order banao: { kind: 'plan', plan: 'BASIC' }  ya  { kind: 'credits', amount: 100 }
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    let kind = b.kind, plan = null, credits = null, base;
    if (kind === 'plan') {
      plan = P.lookup(b.plan);
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      const can = await P.checkCanBuy(req.merchant.id, plan);
      if (!can.ok) return res.status(400).json({ success: false, message: can.message });
      base = plan.price;
    } else if (kind === 'credits') {
      credits = Number(b.amount);
      if (!Number.isInteger(credits) || credits < MIN_CREDITS || credits > MAX_CREDITS) {
        return res.status(400).json({ success: false, message: `Credits must be a whole number between ${MIN_CREDITS} and ${MAX_CREDITS}` });
      }
      base = credits;
    } else {
      return res.status(400).json({ success: false, message: "kind must be 'plan' or 'credits'" });
    }

    const acct = await getPlatformAccount();
    if (!acct) return res.status(503).json({ success: false, code: 'PLATFORM_ACCOUNT_MISSING', message: 'Payments are temporarily unavailable. Please try again later.' });

    // Purane pending orders expire karo (unique amount free ho)
    await supabase.from('billing_orders').update({ status: 'expired' }).eq('status', 'pending').lt('expires_at', new Date().toISOString());

    // Isi merchant ka wahi pending order ho to wahi wapas (refresh par naya amount nahi)
    const { data: open } = await supabase.from('billing_orders').select('*').eq('merchant_id', req.merchant.id).eq('status', 'pending').eq('kind', kind);
    const same = (open || []).find((o) => new Date(o.expires_at) > new Date() && (kind === 'plan' ? o.plan_name === plan.name : Number(o.credits) === credits));
    if (same) return res.json({ success: true, data: view(same, acct) });

    const orderId = 'BO' + Date.now() + uuidv4().replace(/-/g, '').slice(0, 4).toUpperCase();
    const expiresAt = new Date(Date.now() + ORDER_MINUTES * 60 * 1000).toISOString();
    let created = null;
    for (let i = 0; i < MAX_PAISE_SLOTS; i++) {
      const { data, error } = await supabase.from('billing_orders').insert([{
        order_id: orderId, merchant_id: req.merchant.id, kind,
        plan_name: plan ? plan.name : null, credits, base_amount: base, pay_amount: round2(base + i * 0.01),
        status: 'pending', fulfilled: false, expires_at: expiresAt
      }]).select().single();
      if (!error) { created = data; break; }
      if (error.code !== '23505') throw error;               // 23505 = ye amount abhi kisi aur ke pending order me
    }
    if (!created) return res.status(429).json({ success: false, message: 'Too many payments in progress. Please try again in a few minutes.' });
    return res.status(201).json({ success: true, data: view(created, acct) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Status (frontend har 3-5 sec poll kare). paid + fulfilled = access mil gaya.
router.get('/status/:orderId', authMiddleware, async (req, res) => {
  try {
    const o = await mine(req);
    if (!o) return res.status(404).json({ success: false, message: 'Order not found' });
    const acct = await getPlatformAccount();
    await evaluate(o, acct);
    const { data: fresh } = await supabase.from('billing_orders').select('*').eq('order_id', o.order_id).maybeSingle();
    return res.json({ success: true, data: view(fresh || o, acct) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Manual UTR verify (auto-detect me der ho to)
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const utr = String((req.body && req.body.utr) || '').trim();
    if (!/^[A-Za-z0-9]{6,30}$/.test(utr)) return res.status(400).json({ success: false, message: 'Invalid UTR format' });
    const o = await mine(req);
    if (!o) return res.status(404).json({ success: false, message: 'Order not found' });
    const acct = await getPlatformAccount();
    const st = await evaluate(o, acct, utr);
    if (st !== 'paid') return res.status(400).json({ success: false, message: `Payment of ₹${Number(o.pay_amount).toFixed(2)} with this UTR not found. Pay the exact amount shown.` });
    const { data: fresh } = await supabase.from('billing_orders').select('*').eq('order_id', o.order_id).maybeSingle();
    return res.json({ success: true, data: view(fresh, acct) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/cancel/:orderId', authMiddleware, async (req, res) => {
  try {
    const o = await mine(req);
    if (!o) return res.status(404).json({ success: false, message: 'Order not found' });
    await supabase.from('billing_orders').update({ status: 'cancelled' }).eq('order_id', o.order_id).eq('status', 'pending');
    return res.json({ success: true, message: 'Cancelled' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('billing_orders').select('*').eq('merchant_id', req.merchant.id).order('created_at', { ascending: false }).limit(50);
    return res.json({ success: true, data: (data || []).map((o) => view(o, null)) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.evaluate = evaluate;
