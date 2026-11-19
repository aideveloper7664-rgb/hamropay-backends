const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { resolveBranding } = require('../services/themes');
const {
  SESSION_MINUTES, MAX_PAISE_SLOTS, round2,
  decryptAppPassword, buildUpiUri, getActiveCashier, settlePayment, evaluateSession, getFamPayHistory
} = require('../services/checkout.service');
const paytmService = require('../services/paytm.service');

// Naye checkout sessions ki spam rokne ke liye (per link, per minute)
const sessionHits = new Map();
function allowNewSession(linkId) {
  const now = Date.now();
  const arr = (sessionHits.get(linkId) || []).filter((t) => now - t < 60 * 1000);
  if (arr.length >= 30) return false;
  arr.push(now);
  sessionHits.set(linkId, arr);
  return true;
}

// Create Payment Link
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { title, amount, note, is_test } = req.body;

    if (!title || !amount) {
      return res.status(400).json({ success: false, message: 'Title and amount required' });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    // Check if merchant has active cashier
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('id, upi_id, type')
      .eq('merchant_id', req.merchant.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!cashier) {
      return res.status(400).json({
        success: false,
        message: 'Please connect FamPay or Paytm account first to create payment links'
      });
    }

    // Check Hamro Credit balance
    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (!credit || credit.balance <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient Hamro Credits. Please purchase more credits.'
      });
    }

    const linkId = 'lnk_' + uuidv4().replace(/-/g, '').slice(0, 16);

    const { data, error } = await supabase
      .from('payment_links')
      .insert([{
        merchant_id: req.merchant.id,
        link_id: linkId,
        title,
        amount,
        note,
        status: 'active',
        is_test: is_test === true,
        total_collected: 0,
        total_orders: 0
      }])
      .select()
      .single();

    if (error) throw error;

    const paymentUrl = `${process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app'}/pay/${linkId}`;

    return res.status(201).json({
      success: true,
      data: {
        ...data,
        payment_url: paymentUrl,
        upi_id: cashier.upi_id,
        cashier_type: cashier.type,
        qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=upi://pay?pa=${cashier.upi_id}&pn=Payment&am=${amount}&cu=INR`
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get all links
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_links')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const links = data.map(link => ({
      ...link,
      payment_url: `${process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app'}/pay/${link.link_id}`
    }));

    return res.json({ success: true, data: links });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get single link (public)
router.get('/:linkId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_links')
      .select('*, merchants(*)')
      .eq('link_id', req.params.linkId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'Payment link not found' });
    }

    // Merchant disabled this link -> customer must not be able to pay
    if (data.status !== 'active') {
      return res.status(403).json({
        success: false,
        code: 'LINK_DISABLED',
        message: 'This payment link is currently disabled by the merchant'
      });
    }

    // Get merchant active cashier
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('upi_id, type')
      .eq('merchant_id', data.merchants.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!cashier) {
      return res.status(409).json({ success: false, message: 'Merchant has no active payment account' });
    }

    // Only safe, public fields (never spread the DB row: it can contain merchant data)
    return res.json({
      success: true,
      data: {
        link_id: data.link_id,
        title: data.title,
        amount: data.amount,
        note: data.note,
        status: data.status,
        is_test: !!data.is_test,
        merchant_name: data.merchants?.name || '',
        branding: resolveBranding(data.merchants),
        upi_id: cashier.upi_id,
        cashier_type: cashier.type,
        qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=${encodeURIComponent(`upi://pay?pa=${cashier.upi_id}&pn=Payment&am=${data.amount}&cu=INR`)}`
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Update link: enable/disable, test mode, edit details (merchant only)
router.patch('/:linkId', authMiddleware, async (req, res) => {
  try {
    const { status, is_test, title, amount, note } = req.body;
    const updates = {};

    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ success: false, message: "status must be 'active' or 'inactive'" });
      }
      updates.status = status;
    }
    if (is_test !== undefined) {
      if (typeof is_test !== 'boolean') {
        return res.status(400).json({ success: false, message: 'is_test must be true or false' });
      }
      updates.is_test = is_test;
    }
    if (title !== undefined) {
      if (!String(title).trim()) {
        return res.status(400).json({ success: false, message: 'Title cannot be empty' });
      }
      updates.title = String(title).trim();
    }
    if (amount !== undefined) {
      if (!(Number(amount) > 0)) {
        return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
      }
      updates.amount = Number(amount);
    }
    if (note !== undefined) updates.note = note;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('payment_links')
      .update(updates)
      .eq('link_id', req.params.linkId)
      .eq('merchant_id', req.merchant.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: 'Payment link not found' });
    }

    return res.json({
      success: true,
      data: {
        ...data,
        payment_url: `${process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app'}/pay/${data.link_id}`
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Delete link
router.delete('/:linkId', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('payment_links')
      .delete()
      .eq('link_id', req.params.linkId)
      .eq('merchant_id', req.merchant.id);

    if (error) throw error;
    return res.json({ success: true, message: 'Link deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ======================= CHECKOUT SESSIONS (auto-detect) =======================

// Customer pay page khulne par: is checkout ke liye unique amount reserve karo
router.post('/:linkId/session', async (req, res) => {
  try {
    const { data: link } = await supabase
      .from('payment_links')
      .select('*')
      .eq('link_id', req.params.linkId)
      .maybeSingle();

    if (!link) return res.status(404).json({ success: false, message: 'Payment link not found' });
    if (link.status !== 'active') {
      return res.status(403).json({ success: false, code: 'LINK_DISABLED', message: 'This payment link is currently disabled by the merchant' });
    }
    // Test links me auto-detect nahi hota (wahan sirf test UTR chalta hai)
    if (link.is_test) return res.json({ success: true, test_mode: true, data: null });

    const cashier = await getActiveCashier(link.merchant_id);
    if (!cashier) {
      return res.status(409).json({ success: false, message: 'Merchant has no active payment account' });
    }

    const toPayload = (sess) => ({
      session_id: sess.session_id,
      status: sess.status,
      base_amount: Number(sess.base_amount),
      pay_amount: Number(sess.pay_amount),
      expires_at: sess.expires_at,
      server_time: new Date().toISOString(),
      upi_id: cashier.upi_id,
      upi_uri: buildUpiUri(cashier, sess.pay_amount, sess.session_id),
      qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=${encodeURIComponent(buildUpiUri(cashier, sess.pay_amount, sess.session_id))}`
    });

    // Page refresh par purana checkout wapas lo (naya amount mat banao)
    const resumeId = req.body && req.body.session_id;
    if (resumeId) {
      const { data: old } = await supabase
        .from('checkout_sessions')
        .select('*')
        .eq('session_id', String(resumeId))
        .eq('link_id', link.link_id)
        .maybeSingle();
      if (old && old.status === 'pending' && new Date(old.expires_at) > new Date()) {
        return res.json({ success: true, data: toPayload(old) });
      }
    }

    if (!allowNewSession(link.link_id)) {
      return res.status(429).json({ success: false, message: 'Too many requests. Please wait a minute and try again.' });
    }

    // Expire ho chuke pending sessions ke amount free karo
    await supabase
      .from('checkout_sessions')
      .update({ status: 'expired' })
      .eq('merchant_id', link.merchant_id)
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());

    let created = null;
    for (let i = 0; i < MAX_PAISE_SLOTS; i++) {
      const payAmount = round2(Number(link.amount) + i * 0.01);
      const { data, error } = await supabase
        .from('checkout_sessions')
        .insert([{
          session_id: 'cs_' + crypto.randomBytes(16).toString('hex'),
          merchant_id: link.merchant_id,
          link_id: link.link_id,
          base_amount: link.amount,
          pay_amount: payAmount,
          status: 'pending',
          expires_at: new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString()
        }])
        .select()
        .single();

      if (!error) { created = data; break; }
      if (error.code !== '23505') throw error; // 23505 = ye amount abhi kisi aur checkout ke paas hai, agla try karo
    }

    if (!created) {
      return res.status(429).json({ success: false, message: 'Too many checkouts in progress. Please try again in a few minutes.' });
    }

    return res.status(201).json({ success: true, data: toPayload(created) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Page har 3 second me ye poochta hai. Backend Gmail check karke payment mile to khud confirm kar deta hai.
router.get('/session/:sid/status', async (req, res) => {
  try {
    const { data: s } = await supabase
      .from('checkout_sessions')
      .select('*')
      .eq('session_id', req.params.sid)
      .maybeSingle();

    if (!s) return res.status(404).json({ success: false, message: 'Checkout not found' });

    const r = await evaluateSession(s);

    return res.json({
      success: true,
      data: {
        status: r.status,
        pay_amount: Number(s.pay_amount),
        expires_at: s.expires_at,
        server_time: new Date().toISOString(),
        utr: r.status === 'paid' ? r.utr : null,
        order_id: r.status === 'paid' ? r.order_id : null,
        ...r.extra
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Customer "Cancel payment" dabaye to checkout band, amount free
router.post('/session/:sid/cancel', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('checkout_sessions')
      .update({ status: 'cancelled' })
      .eq('session_id', req.params.sid)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) throw error;
    // Pehle se paid/expired/cancelled ho to bhi theek hai (idempotent)
    return res.json({ success: true, data: { cancelled: !!data } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ======================= MANUAL VERIFY (UTR) =======================
router.post('/:linkId/verify', async (req, res) => {
  try {
    const utr = String((req.body && req.body.utr) || '').trim();
    const sessionId = req.body && req.body.session_id;

    if (!utr) {
      return res.status(400).json({ success: false, message: 'UTR required' });
    }
    if (!/^[A-Za-z0-9]{6,30}$/.test(utr)) {
      return res.status(400).json({ success: false, message: 'Invalid UTR format' });
    }

    const { data: link, error: linkError } = await supabase
      .from('payment_links')
      .select('*, merchants(*)')
      .eq('link_id', req.params.linkId)
      .single();

    if (linkError || !link) {
      return res.status(404).json({ success: false, message: 'Payment link not found' });
    }

    if (link.status !== 'active') {
      return res.status(403).json({
        success: false,
        code: 'LINK_DISABLED',
        message: 'This payment link is currently disabled by the merchant'
      });
    }

    // ---------- TEST MODE: no Gmail check, no wallet, no credits, no DB writes ----------
    if (link.is_test) {
      const TEST_UTR = '000000000000';
      if (utr !== TEST_UTR) {
        return res.status(400).json({
          success: false,
          test_mode: true,
          message: `Test mode: enter UTR ${TEST_UTR} to simulate a successful payment`
        });
      }

      const testOrderId = 'TEST_' + uuidv4().replace(/-/g, '').toUpperCase().slice(0, 12);

      if (link.merchants && link.merchants.webhook_url) {
        fetch(link.merchants.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'payment.test',
            test: true,
            order_id: testOrderId,
            link_id: req.params.linkId,
            utr: TEST_UTR,
            amount: link.amount
          })
        }).catch(() => {});
      }

      return res.json({
        success: true,
        test_mode: true,
        message: 'Test payment successful (no real money moved)',
        data: { order_id: testOrderId, utr: TEST_UTR, amount: link.amount, net_amount: link.amount, commission: 0, test: true }
      });
    }

    // Checkout session ho to uska unique amount expect karo
    let session = null;
    if (sessionId) {
      const { data: sess } = await supabase
        .from('checkout_sessions')
        .select('*')
        .eq('session_id', String(sessionId))
        .eq('link_id', link.link_id)
        .maybeSingle();
      session = sess || null;
      if (session && session.status === 'paid') {
        return res.status(400).json({ success: false, message: 'This checkout is already paid' });
      }
    }
    const expectedAmount = session ? Number(session.pay_amount) : Number(link.amount);

    // Check UTR already used
    const { data: existingTxn } = await supabase
      .from('transactions')
      .select('id')
      .eq('utr', utr)
      .maybeSingle();

    if (existingTxn) {
      return res.status(400).json({ success: false, message: 'UTR already used' });
    }

    const cashier = await getActiveCashier(link.merchants.id);

    let verified = null;

    if (cashier && cashier.type === 'paytm_mid') {
      // Paytm MID: session_id hi Paytm ORDERID hai. Typed UTR Paytm ke bank txn id ya txn id se bilkul same hona chahiye.
      if (!session) {
        return res.status(400).json({ success: false, message: 'Please reopen the checkout page and pay using the QR shown there.' });
      }
      let r;
      try {
        r = await paytmService.getOrderStatus(cashier.paytm_mid, decryptAppPassword(cashier.paytm_merchant_key), session.session_id);
      } catch (e) {
        console.error('[verify] paytm error:', e && e.message);
        return res.status(502).json({ success: false, message: 'Could not reach Paytm right now. Please try again in a moment.' });
      }
      if (paytmService.isPaid(r, session.session_id, expectedAmount) && [r.bankTxnId, r.txnId].includes(utr)) {
        verified = { messageId: null };
      }
    } else if (cashier && ['fampay', 'amazon', 'paytm'].includes(cashier.type) && cashier.gmail_app_password) {
      // Exact match only: typed UTR/Txn ID email ke UTR ya Transaction ID se bilkul same hona chahiye
      let scan;
      try {
        scan = await getFamPayHistory(`${link.merchants.id}:${cashier.id}:manual`, {
          email: cashier.gmail_email,
          appPassword: decryptAppPassword(cashier.gmail_app_password),
          days: 7,
          limit: 50,
          ttlMs: 3000,
          provider: cashier.type
        });
      } catch (e) {
        console.error('[verify] gmail error:', e && e.message);
        return res.status(502).json({ success: false, message: 'Could not read payment emails right now. Please try again in a moment.' });
      }

      const hit = scan.transactions.find((t) =>
        (t.reference === utr || t.alt_reference === utr) &&
        Math.abs(t.amount - expectedAmount) < 0.005
      );
      if (hit) verified = { messageId: hit.message_id };
    } else {
      // Non-FamPay cashier: purana tarika
      const gmailService = require('../services/gmail.service');
      verified = await gmailService.verifyUTR(utr, expectedAmount);
    }

    if (!verified) {
      return res.status(400).json({
        success: false,
        message: session
          ? `Payment of ₹${expectedAmount.toFixed(2)} not found. Check UTR and make sure you paid the exact amount.`
          : 'Payment not found. Check UTR and try again.'
      });
    }

    const result = await settlePayment({
      link,
      merchant: link.merchants,
      payAmount: expectedAmount,
      utr,
      messageId: verified.messageId
    });

    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }

    if (session) {
      await supabase
        .from('checkout_sessions')
        .update({ status: 'paid', utr, order_id: result.data.order_id, paid_at: new Date().toISOString() })
        .eq('session_id', session.session_id);
    }

    return res.json({ success: true, message: 'Payment verified!', data: result.data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});
module.exports = router;
