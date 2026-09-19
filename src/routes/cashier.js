const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { google } = require('googleapis');
require('dotenv').config();

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

    // Verify Gmail App Password
    try {
      const oauth2Client = new google.auth.OAuth2();
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const transporter = require('nodemailer').createTransport({
        service: 'gmail',
        auth: {
          user: gmail_email,
          pass: gmail_app_password
        }
      });

      await transporter.verify();
    } catch (gmailErr) {
      return res.status(400).json({ success: false, message: 'Invalid Email or App Password. Please generate a new App Password and try again.' });
    }

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
        is_active: existing.length === 0,
        is_verified: true
      }])
      .select('id, type, upi_id, phone, gmail_email, is_active, is_verified')
      .single();

    if (error) throw error;

    return res.json({ success: true, data, message: 'FamPay account connected successfully' });
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

    // Check max 3 accounts
    const { data: existing } = await supabase
      .from('cashier_accounts')
      .select('id')
      .eq('merchant_id', req.merchant.id)
      .eq('type', 'paytm');

    if (existing && existing.length >= 3) {
      return res.status(400).json({ success: false, message: 'Max 3 Paytm accounts allowed' });
    }

    const { data, error } = await supabase
      .from('cashier_accounts')
      .insert([{
        merchant_id: req.merchant.id,
        type: 'paytm',
        upi_id,
        phone,
        paytm_mid: paytm_mid || null,
        is_active: existing.length === 0,
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
    const { type } = req.body;

    // Deactivate all of same type
    await supabase
      .from('cashier_accounts')
      .update({ is_active: false })
      .eq('merchant_id', req.merchant.id)
      .eq('type', type);

    // Activate selected
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

// Get active cashier for payment
router.get('/active', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cashier_accounts')
      .select('id, type, upi_id, phone, gmail_email')
      .eq('merchant_id', req.merchant.id)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'No active cashier found' });
    }

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;