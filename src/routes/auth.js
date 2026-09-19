const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { sendOTP, sendPasswordReset } = require('../services/email.service');
require('dotenv').config();

const generateReferralCode = () => {
  return 'HAMRO' + Math.random().toString(36).substring(2, 7).toUpperCase();
};

// Merchant Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, webhook_url, referral_code } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const apiKey = 'hmpay_' + uuidv4().replace(/-/g, '');
    const myReferralCode = generateReferralCode();

    // Check referral code
    let referredBy = null;
    if (referral_code) {
      const { data: referrer } = await supabase
        .from('merchants')
        .select('id')
        .eq('referral_code', referral_code)
        .single();
      if (referrer) referredBy = referrer.id;
    }

    const { data: merchant, error } = await supabase
      .from('merchants')
      .insert([{
        name,
        email,
        password: hashedPassword,
        api_key: apiKey,
        webhook_url,
        referral_code: myReferralCode,
        referred_by: referredBy
      }])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ success: false, message: 'Email already exists' });
      }
      throw error;
    }

    // Create wallet
    await supabase.from('wallets').insert([{ merchant_id: merchant.id }]);

    // Auto 20 Hamro Credit
    await supabase.from('hamro_credits').insert([{
      merchant_id: merchant.id,
      balance: 20,
      total_purchased: 0,
      total_spent: 0
    }]);

    await supabase.from('credit_transactions').insert([{
      merchant_id: merchant.id,
      type: 'purchase',
      amount: 20,
      note: 'Welcome bonus — 20 free Hamro Credits'
    }]);

    // Save referral record
    if (referredBy) {
      await supabase.from('referrals').insert([{
        referrer_id: referredBy,
        referred_id: merchant.id,
        status: 'pending'
      }]);
    }

    return res.status(201).json({
      success: true,
      message: 'Merchant registered successfully',
      data: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        api_key: apiKey,
        referral_code: myReferralCode
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Merchant Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const { data: merchant, error } = await supabase
      .from('merchants')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !merchant) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, merchant.password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: merchant.id, email: merchant.email, role: 'merchant' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          api_key: merchant.api_key,
          referral_code: merchant.referral_code
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Send OTP
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email required' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Delete old OTPs
    await supabase.from('otps').delete().eq('email', email);

    // Save new OTP
    await supabase.from('otps').insert([{ email, otp, expires_at: expiresAt }]);

    // Send email
    const sent = await sendOTP(email, otp);
    if (!sent) {
      return res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }

    return res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Verify OTP Login
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP required' });
    }

    const { data: otpRecord, error } = await supabase
      .from('otps')
      .select('*')
      .eq('email', email)
      .eq('otp', otp)
      .eq('used', false)
      .single();

    if (error || !otpRecord) {
      return res.status(401).json({ success: false, message: 'Invalid OTP' });
    }

    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(401).json({ success: false, message: 'OTP expired' });
    }

    // Mark OTP as used
    await supabase.from('otps').update({ used: true }).eq('id', otpRecord.id);

    // Find or create merchant
    let { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('email', email)
      .single();

    if (!merchant) {
      // Auto register
      const apiKey = 'hmpay_' + uuidv4().replace(/-/g, '');
      const referralCode = generateReferralCode();
      const name = email.split('@')[0];

      const { data: newMerchant } = await supabase
        .from('merchants')
        .insert([{
          name,
          email,
          password: await bcrypt.hash(uuidv4(), 10),
          api_key: apiKey,
          referral_code: referralCode
        }])
        .select()
        .single();

      await supabase.from('wallets').insert([{ merchant_id: newMerchant.id }]);
      await supabase.from('hamro_credits').insert([{
        merchant_id: newMerchant.id,
        balance: 20,
        total_purchased: 0,
        total_spent: 0
      }]);
      await supabase.from('credit_transactions').insert([{
        merchant_id: newMerchant.id,
        type: 'purchase',
        amount: 20,
        note: 'Welcome bonus — 20 free Hamro Credits'
      }]);

      merchant = newMerchant;
    }

    const token = jwt.sign(
      { id: merchant.id, email: merchant.email, role: 'merchant' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          api_key: merchant.api_key,
          referral_code: merchant.referral_code
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Google Login
router.post('/google', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Google token required' });
    }

    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { email, name, sub: googleId } = payload;

    // Find or create merchant
    let { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('email', email)
      .single();

    if (!merchant) {
      const apiKey = 'hmpay_' + uuidv4().replace(/-/g, '');
      const referralCode = generateReferralCode();

      const { data: newMerchant } = await supabase
        .from('merchants')
        .insert([{
          name,
          email,
          password: await bcrypt.hash(googleId, 10),
          api_key: apiKey,
          referral_code: referralCode
        }])
        .select()
        .single();

      await supabase.from('wallets').insert([{ merchant_id: newMerchant.id }]);
      await supabase.from('hamro_credits').insert([{
        merchant_id: newMerchant.id,
        balance: 20,
        total_purchased: 0,
        total_spent: 0
      }]);
      await supabase.from('credit_transactions').insert([{
        merchant_id: newMerchant.id,
        type: 'purchase',
        amount: 20,
        note: 'Welcome bonus — 20 free Hamro Credits'
      }]);

      merchant = newMerchant;
    }

    const jwtToken = jwt.sign(
      { id: merchant.id, email: merchant.email, role: 'merchant' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      data: {
        token: jwtToken,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          api_key: merchant.api_key,
          referral_code: merchant.referral_code
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Forgot Password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email required' });
    }

    const { data: merchant } = await supabase
      .from('merchants')
      .select('id')
      .eq('email', email)
      .single();

    if (!merchant) {
      return res.json({ success: true, message: 'If email exists, reset link sent' });
    }

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await supabase.from('password_resets').delete().eq('email', email);
    await supabase.from('password_resets').insert([{ email, token, expires_at: expiresAt }]);

    const sent = await sendPasswordReset(email, token);
    if (!sent) {
      return res.status(500).json({ success: false, message: 'Failed to send reset email' });
    }

    return res.json({ success: true, message: 'Password reset link sent to your email' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'Token and password required' });
    }

    const { data: reset, error } = await supabase
      .from('password_resets')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (error || !reset) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    if (new Date() > new Date(reset.expires_at)) {
      return res.status(400).json({ success: false, message: 'Reset link expired' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await supabase
      .from('merchants')
      .update({ password: hashedPassword })
      .eq('email', reset.email);

    await supabase
      .from('password_resets')
      .update({ used: true })
      .eq('id', reset.id);

    return res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Login
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
    }

    const token = jwt.sign(
      { email, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Admin login successful',
      data: { token }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;