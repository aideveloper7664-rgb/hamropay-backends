const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { getFamPayHistory } = require('./history.service');

const SESSION_MINUTES = 8;      // payment-link checkout kitni der valid rahe
const MAX_PAISE_SLOTS = 50;     // ek merchant ke max itne parallel pending checkouts (x.00 ... x.49)
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---- helpers ----
function decryptAppPassword(encrypted) {
  const key = process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32);
  const [ivHex, data] = encrypted.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  let out = decipher.update(data, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

async function getActiveCashier(merchantId) {
  const { data } = await supabase
    .from('cashier_accounts')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// Payment confirm hone ke baad sab kuch yahin hota hai.
// Payment-link payment: link diya hota hai. Developer API order: link = null, orderCode = 'HP...'
async function settlePayment({ link = null, merchant, payAmount, utr, messageId, orderCode = null }) {
  const commissionPercent = merchant.commission || 2;
  // Paisa seedha merchant ke apne UPI me aata hai (Hamro Cash / wallet nahi). Isliye merchant ko poora payAmount milta hai.
  // Commission alag se Hamro Credits se kati jaati hai.
  const commission = round2((payAmount * commissionPercent) / 100);
  const netAmount = round2(payAmount);

  const { data: credit } = await supabase
    .from('hamro_credits')
    .select('balance, total_spent')
    .eq('merchant_id', merchant.id)
    .single();

  if (!credit || credit.balance < commission) {
    return { ok: false, status: 400, message: 'Insufficient Hamro Credits. Please purchase more credits.' };
  }

  const orderId = orderCode || ('ORD_' + uuidv4().replace(/-/g, '').toUpperCase().slice(0, 16));

  const { data: order } = await supabase
    .from('orders')
    .insert([{
      merchant_id: merchant.id,
      order_id: orderId,
      amount: payAmount,
      status: 'success',
      utr,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    }])
    .select()
    .single();

  const { error: txnError } = await supabase.from('transactions').insert([{
    order_id: order.id,
    merchant_id: merchant.id,
    amount: payAmount,
    commission,
    net_amount: netAmount,
    utr,
    gmail_message_id: messageId || null
  }]);

  if (txnError) {
    await supabase.from('orders').delete().eq('order_id', orderId);
    return { ok: false, status: 400, message: 'UTR already used' };
  }

  await supabase.from('hamro_credits').update({
    balance: round2(credit.balance - commission),
    total_spent: round2((credit.total_spent || 0) + commission),
    updated_at: new Date().toISOString()
  }).eq('merchant_id', merchant.id);

  await supabase.from('credit_transactions').insert([{
    merchant_id: merchant.id,
    type: 'deduct',
    amount: commission,
    order_id: orderId,
    note: link ? `Commission for link ${link.link_id}` : `Commission for order ${orderId}`
  }]);

  if (link) {
    await supabase.from('payment_links').update({
      total_collected: round2((link.total_collected || 0) + payAmount),
      total_orders: (link.total_orders || 0) + 1
    }).eq('link_id', link.link_id);
  }

  if (merchant.webhook_url) {
    fetch(merchant.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'payment.success',
        order_id: orderId,
        link_id: link ? link.link_id : null,
        utr,
        amount: payAmount,
        net_amount: netAmount,
        commission
      })
    }).catch(() => {});
  }

  return { ok: true, data: { order_id: orderId, utr, amount: payAmount, net_amount: netAmount, commission } };
}

// Ek checkout session (payment-link ya developer order) ko check karo:
// expiry, link disabled, Gmail me payment mili ya nahi. Mile to atomic claim + settle.
// Return: { status, utr, order_id, extra }   status: pending | paid | expired | cancelled | disabled | failed
async function evaluateSession(s) {
  const done = (status, extra = {}) => ({ status, utr: s.utr || null, order_id: s.order_id || null, extra });

  if (s.status !== 'pending') return done(s.status, s.status === 'failed' && s.fail_reason ? { message: s.fail_reason } : {});

  if (new Date(s.expires_at) <= new Date()) {
    await supabase.from('checkout_sessions').update({ status: 'expired' }).eq('session_id', s.session_id).eq('status', 'pending');
    return done('expired');
  }

  // Test order me asli payment nahi hoti (simulator se hi complete hota hai)
  if (s.is_test) return done('pending', { test_mode: true });

  let link = null;
  let merchant = null;
  if (s.link_id) {
    const { data } = await supabase
      .from('payment_links')
      .select('*, merchants(*)')
      .eq('link_id', s.link_id)
      .maybeSingle();
    if (!data || data.status !== 'active') return done('disabled');
    link = data;
    merchant = data.merchants;
  } else {
    const { data } = await supabase.from('merchants').select('*').eq('id', s.merchant_id).maybeSingle();
    merchant = data;
  }
  if (!merchant) return done('pending', { auto_detect: false });

  const cashier = await getActiveCashier(s.merchant_id);
  if (!cashier || !['fampay', 'paytm'].includes(cashier.type) || !cashier.gmail_app_password) {
    return done('pending', { auto_detect: false }); // Gmail se detect nahi ho sakta (account Gmail ke saath connect nahi)
  }

  let scan;
  try {
    scan = await getFamPayHistory(`${s.merchant_id}:${cashier.id}:auto`, {
      email: cashier.gmail_email,
      appPassword: decryptAppPassword(cashier.gmail_app_password),
      days: 2,
      limit: 20,
      ttlMs: 5000,
      provider: cashier.type
    });
  } catch (e) {
    console.error('[auto-detect] gmail error:', e && e.message);
    return done('pending', { auto_detect: false, scan_error: true });
  }

  const minTs = new Date(s.created_at).getTime() - 2 * 60 * 1000;
  const candidates = scan.transactions.filter((t) =>
    t.reference &&
    Math.abs(t.amount - Number(s.pay_amount)) < 0.005 &&
    (t.mail_date || t.date) && new Date(t.mail_date || t.date).getTime() >= minTs   // email header Date (UTC) se: body ke minute-precision time par bharosa nahi
  );

  for (const t of candidates) {
    const { data: used } = await supabase.from('transactions').select('id').eq('utr', t.reference).maybeSingle();
    if (used) continue;

    // Atomic claim: sirf ek hi request is session ko paid bana sakti hai
    const { data: claimed } = await supabase
      .from('checkout_sessions')
      .update({ status: 'paid', utr: t.reference, paid_at: new Date().toISOString() })
      .eq('session_id', s.session_id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (!claimed) {
      const { data: fresh } = await supabase.from('checkout_sessions').select('*').eq('session_id', s.session_id).maybeSingle();
      return fresh ? { status: fresh.status, utr: fresh.utr || null, order_id: fresh.order_id || null, extra: {} } : done(s.status);
    }

    const result = await settlePayment({
      link,
      merchant,
      payAmount: Number(s.pay_amount),
      utr: t.reference,
      messageId: t.message_id,
      orderCode: s.link_id ? null : s.session_id   // developer order: order_id wahi rahe (HP...)
    });

    if (!result.ok) {
      await supabase.from('checkout_sessions').update({ status: 'failed' }).eq('session_id', s.session_id);
      await supabase.from('checkout_sessions').update({ fail_reason: result.message }).eq('session_id', s.session_id); // column na ho to chup-chaap skip
      return { status: 'failed', utr: t.reference, order_id: null, extra: { message: result.message } };
    }

    await supabase.from('checkout_sessions').update({ order_id: result.data.order_id }).eq('session_id', s.session_id);
    return { status: 'paid', utr: t.reference, order_id: result.data.order_id, extra: {} };
  }

  return done('pending', { auto_detect: true });
}

module.exports = {
  SESSION_MINUTES, MAX_PAISE_SLOTS, round2,
  decryptAppPassword, getActiveCashier, settlePayment, evaluateSession,
  getFamPayHistory
};
