const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
require('dotenv').config();

// Does this merchant already have ANY active cashier (fampay or paytm)?
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

// Add FamPay account
router.post('/fampay/add', authMiddleware, async (req, res) => {
  try {
    const { upi_id, phone, gmail_email, gmail_app_password } = req.body;

    if (!upi_id || !phone || !gmail_email || !gmail_app_password) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }

    // Check max 3 accounts
    const { data: existing } = await supabase
      .from('cashier_accounts')
      .select('id')
      .eq('merchant_id', req.merchant.id)
      .eq('type', 'fampay');

    if (existing && existing.length >= 3) {
      return res.status(400).json({ success: false, message: 'Max 3 FamPay accounts allowed' });
    }

    const hasActive = await merchantHasActiveCashier(req.merchant.id);

    // Encrypt app password
    const crypto = require('crypto');
    const key = process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(gmail_app_password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const encryptedPass = iv.toString('hex') + ':' + encrypted;

    // Save account
    const { data, error } = await supabase
      .from('cashier_accounts')
      .insert([{
        merchant_id: req.merchant.id,
        type: 'fampay',
        upi_id,
        phone,
        gmail_email,
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
      message: 'FamPay account connected successfully'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Add Paytm account
router.post('/paytm/add', authMiddleware, async (req, res) => {
  try {
    const { upi_id, phone, paytm_mid } = req.body;

    if (!upi_id || !phone) {
      return res.status(400).json({ success: false, message: 'UPI ID and phone required' });
    }

    const { data: existing } = await supabase
      .from('cashier_accounts')
      .select('id')
      .eq('merchant_id', req.merchant.id)
      .eq('type', 'paytm');

    if (existing && existing.length >= 3) {
      return res.status(400).json({ success: false, message: 'Max 3 Paytm accounts allowed' });
    }

    const hasActive = await merchantHasActiveCashier(req.merchant.id);

    const { data, error } = await supabase
      .from('cashier_accounts')
      .insert([{
        merchant_id: req.merchant.id,
        type: 'paytm',
        upi_id,
        phone,
        paytm_mid: paytm_mid || null,
        is_active: !hasActive,
        is_verified: true
      }])
      .select('id, type, upi_id, phone, is_active, is_verified')
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      data,
      message: 'Paytm account connected successfully'
    });
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

    // Only ONE active cashier per merchant (across fampay + paytm)
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
    if (cashier.type !== 'fampay' || !cashier.gmail_app_password || !cashier.gmail_email) {
      return res.status(400).json({ success: false, code: 'NOT_FAMPAY', message: 'Email history is available for FamPay accounts only' });
    }

    // Decrypt app password
    const crypto = require('crypto');
    const key = process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32);
    const [ivHex, encrypted] = cashier.gmail_app_password.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    let appPassword = decipher.update(encrypted, 'hex', 'utf8');
    appPassword += decipher.final('utf8');

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    const { getFamPayHistory, friendlyError } = require('../services/history.service');
    try {
      const data = await getFamPayHistory(`${req.merchant.id}:${cashier.id}`, {
        email: cashier.gmail_email,
        appPassword,
        days,
        limit,
        debug: req.query.debug === '1',
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