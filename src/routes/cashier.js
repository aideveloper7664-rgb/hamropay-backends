const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
require('dotenv').config();

// Does this merchant already have an active cashier?
async function merchantHasActiveCashier(merchantId) {
  const { data } = await supabase
    .from('cashier_accounts')
    .select('id')
    .eq('merchant_id', merchantId)
    .eq('is_active', true)
    .limit(1);
  return !!(data && data.length > 0);
}

// Get all cashier accounts
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cashier_accounts')
      .select('id, type, upi_id, phone, gmail_email, is_active, is_verified, created_at')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// FamPay account: UPI ID + phone + Gmail + App Password.
// Payment Gmail ki emails se detect hoti hai, isliye account add karte waqt Gmail login asli me check hota hai.
function addEmailCashier(type) {
  const label = { amazon: 'Amazon Pay', paytm: 'Paytm' }[type] || 'FamPay';
  const example = { amazon: 'yourname@yapl', paytm: '9876543210@paytm' }[type] || '9876543210@fam';

  return async (req, res) => {
    try {
      const { upi_id, phone, gmail_email, gmail_app_password } = req.body;

      if (!upi_id || !phone || !gmail_email || !gmail_app_password) {
        return res.status(400).json({ success: false, message: 'All fields required' });
      }

      const cleanUpi = String(upi_id).trim();
      const cleanEmail = String(gmail_email).trim().toLowerCase();
      const cleanPass = String(gmail_app_password).replace(/\s/g, '');

      if (!/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9]{2,}$/.test(cleanUpi)) {
        return res.status(400).json({ success: false, message: `Enter a valid UPI ID (like ${example})` });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid Gmail address' });
      }
      if (cleanPass.length < 8) {
        return res.status(400).json({ success: false, message: 'Enter the 16-letter Google App Password' });
      }

      // Check max 3 accounts + duplicates
      const { data: existing } = await supabase
        .from('cashier_accounts')
        .select('id, upi_id, gmail_email')
        .eq('merchant_id', req.merchant.id)
        .eq('type', type);

      if (existing && existing.length >= 3) {
        return res.status(400).json({ success: false, message: `Max 3 ${label} accounts allowed` });
      }
      if (existing && existing.some((a) => a.upi_id === cleanUpi || String(a.gmail_email || '').toLowerCase() === cleanEmail)) {
        return res.status(400).json({ success: false, message: 'This UPI ID or Gmail is already connected' });
      }

      // Gmail login asli me check karo: galat App Password wala account kabhi save na ho
      const { verifyGmailLogin, friendlyError } = require('../services/history.service');
      try {
        await verifyGmailLogin(cleanEmail, cleanPass);
      } catch (err) {
        const e = friendlyError(err);
        console.error(`[${type}/add] gmail check failed:`, e.code);
        // 401 nahi bhejte: frontend use "logout" samajh sakta hai
        return res.status(e.code === 'GMAIL_AUTH' ? 400 : e.status).json({ success: false, code: e.code, message: e.message });
      }

      const hasActive = await merchantHasActiveCashier(req.merchant.id);

      // Encrypt app password
      const crypto = require('crypto');
      const key = process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(cleanPass, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const encryptedPass = iv.toString('hex') + ':' + encrypted;

      // Save account
      const { data, error } = await supabase
        .from('cashier_accounts')
        .insert([{
          merchant_id: req.merchant.id,
          type,
          upi_id: cleanUpi,
          phone,
          gmail_email: cleanEmail,
          gmail_app_password: encryptedPass,
          is_active: !hasActive,
          is_verified: true
        }])
        .select('id, type, upi_id, phone, gmail_email, is_active, is_verified')
        .single();

      if (error) throw error;

      return res.json({
        success: true,
        data,
        message: `${label} account connected successfully`
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  };
}

// Add FamPay account
router.post('/fampay/add', authMiddleware, addEmailCashier('fampay'));

// Add Amazon Pay account (wallet top-up email se detect hota hai; same Gmail + App Password flow)
router.post('/amazon/add', authMiddleware, addEmailCashier('amazon'));

// Add Paytm account (Gmail email se detect hota hai; same Gmail + App Password flow)
// NOTE: Paytm ka parser abhi tak asli Paytm email se test nahi hua (tolerant parser) - pehle real email se check karo.
router.post('/paytm/add', authMiddleware, addEmailCashier('paytm'));

// Add Paytm account via MID + Merchant Key (official Paytm status API; Gmail ki zarurat nahi)
// Customer ke UPI link me tr=<checkout session id> jaata hai, wahi Paytm ORDERID banta hai.
router.post('/paytm-mid/add', authMiddleware, async (req, res) => {
  try {
    const { upi_id, phone, paytm_mid, paytm_merchant_key } = req.body || {};
    if (!upi_id || !phone || !paytm_mid || !paytm_merchant_key) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }

    const cleanUpi = String(upi_id).trim();
    const cleanPhone = String(phone).trim();
    const cleanMid = String(paytm_mid).trim();
    const cleanKey = String(paytm_merchant_key).trim();

    if (!/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9]{2,}$/.test(cleanUpi)) {
      return res.status(400).json({ success: false, message: 'Enter a valid UPI ID (like 9876543210@paytm)' });
    }
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });
    }
    if (!/^[A-Za-z0-9]{6,30}$/.test(cleanMid)) {
      return res.status(400).json({ success: false, message: 'Merchant ID looks invalid. Check it in your Paytm Business dashboard.' });
    }
    if (cleanKey.length !== 16) {
      return res.status(400).json({ success: false, message: 'Paytm Merchant Key must be exactly 16 characters.' });
    }

    const { data: existing } = await supabase
      .from('cashier_accounts')
      .select('id, upi_id, paytm_mid')
      .eq('merchant_id', req.merchant.id)
      .eq('type', 'paytm_mid');

    if (existing && existing.length >= 3) {
      return res.status(400).json({ success: false, message: 'Max 3 Paytm accounts allowed' });
    }
    if (existing && existing.some((a) => a.upi_id === cleanUpi || a.paytm_mid === cleanMid)) {
      return res.status(400).json({ success: false, message: 'This UPI ID or Merchant ID is already connected' });
    }

    // MID + Key asli me Paytm se check karo: galat credentials wala account kabhi save na ho
    const paytmService = require('../services/paytm.service');
    const check = await paytmService.checkCredentials(cleanMid, cleanKey);
    if (!check.ok) {
      console.error('[paytm-mid/add] credential check failed:', check.reason);
      return res.status(400).json({ success: false, code: 'PAYTM_' + check.reason, message: check.message });
    }

    const { encryptSecret } = require('../services/checkout.service');
    const hasActive = await merchantHasActiveCashier(req.merchant.id);

    const { data, error } = await supabase
      .from('cashier_accounts')
      .insert([{
        merchant_id: req.merchant.id,
        type: 'paytm_mid',
        upi_id: cleanUpi,
        phone: cleanPhone,
        paytm_mid: cleanMid,
        paytm_merchant_key: encryptSecret(cleanKey),
        is_active: !hasActive,
        is_verified: true
      }])
      .select('id, type, upi_id, phone, is_active, is_verified')
      .single();

    if (error) throw error;
    return res.json({ success: true, data, message: 'Paytm account connected successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Toggle active account
router.patch('/:id/toggle', authMiddleware, async (req, res) => {
  try {
    // Account must belong to this merchant
    const { data: target } = await supabase
      .from('cashier_accounts')
      .select('id')
      .eq('id', req.params.id)
      .eq('merchant_id', req.merchant.id)
      .maybeSingle();

    if (!target) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    // Only ONE active cashier per merchant
    await supabase
      .from('cashier_accounts')
      .update({ is_active: false })
      .eq('merchant_id', req.merchant.id);

    const { error } = await supabase
      .from('cashier_accounts')
      .update({ is_active: true })
      .eq('id', req.params.id)
      .eq('merchant_id', req.merchant.id);

    if (error) throw error;
    return res.json({ success: true, message: 'Account activated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Delete account
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('cashier_accounts')
      .delete()
      .eq('id', req.params.id)
      .eq('merchant_id', req.merchant.id);

    if (error) throw error;
    return res.json({ success: true, message: 'Account removed' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get active cashier
router.get('/active', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cashier_accounts')
      .select('id, type, upi_id, phone, gmail_email')
      .eq('merchant_id', req.merchant.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'No active cashier found' });
    }

    return res.json({ success: true, data, cashier: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Live email history of the ACTIVE FamPay account (reads the merchant's own Gmail)
// ?days=30 (1-90 per window)  ?limit=200 (1-300)  ?before=<ISO date> (purani emails ke liye)  ?refresh=1
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('id, type, gmail_email, gmail_app_password')
      .eq('merchant_id', req.merchant.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!cashier) {
      return res.status(404).json({ success: false, code: 'NO_CASHIER', message: 'No active cashier found' });
    }
    if (!['fampay', 'amazon', 'paytm'].includes(cashier.type)) {
      return res.status(400).json({ success: false, code: 'NOT_SUPPORTED', message: 'Email history is available for FamPay, Amazon Pay and Paytm accounts only' });
    }
    if (!cashier.gmail_app_password || !cashier.gmail_email) {
      return res.status(400).json({ success: false, code: 'NO_GMAIL', message: 'This account has no Gmail connected. Remove it and connect it again with a Gmail App Password.' });
    }

    // Decrypt app password
    const crypto = require('crypto');
    const key = process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32);
    const [ivHex, encrypted] = cashier.gmail_app_password.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    let appPassword = decipher.update(encrypted, 'hex', 'utf8');
    appPassword += decipher.final('utf8');

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 300);

    // before: sirf valid date, aaj se aage nahi, 2 saal se purani nahi
    let before = null;
    if (req.query.before) {
      const d = new Date(String(req.query.before));
      const now = Date.now();
      if (isNaN(d.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid before date' });
      }
      const oldest = now - 730 * 24 * 60 * 60 * 1000;
      before = new Date(Math.min(Math.max(d.getTime(), oldest), now));
      before.setUTCHours(0, 0, 0, 0);
    }

    const { getFamPayHistory, friendlyError } = require('../services/history.service');
    try {
      const data = await getFamPayHistory(`${req.merchant.id}:${cashier.id}:${days}:${limit}:${before ? before.toISOString() : 'now'}`, {
        email: cashier.gmail_email,
        appPassword,
        days,
        limit,
        before,
        debug: req.query.debug === '1',
        provider: cashier.type,
        ttlMs: req.query.refresh === '1' ? 3000 : 10000
      });
      return res.json({ success: true, data });
    } catch (err) {
      const e = friendlyError(err);
      console.error('[cashier/history]', e.code, err?.message);
      return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
