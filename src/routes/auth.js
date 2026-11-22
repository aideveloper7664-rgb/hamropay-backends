const express = require('express');
const router = express.Router();
const P = require('../services/plans.service');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
require('dotenv').config();

const generateReferralCode = () => {
  return 'HAMRO' + Math.random().toString(36).substring(2, 7).toUpperCase();
};

// Email se merchant dhundo, na ho to naya account (wallet + 20 free credits + FREE plan) banao
async function findOrCreateMerchant(email, name) {
  let isNew = false;
  let { data: merchant } = await supabase
    .from('merchants')
    .select('*')
    .eq('email', email)
    .single();

  if (!merchant) {
    const apiKey = 'hmpay_' + uuidv4().replace(/-/g, '');
    const referralCode = generateReferralCode();

    const { data: newMerchant, error: createError } = await supabase
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

    if (createError) throw createError;

    // Create wallet
    await supabase.from('wallets').insert([{ merchant_id: newMerchant.id }]);

    // Auto 20 Hamro Credit
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

    // Create default plan
    const { data: freePlan } = await supabase
      .from('plans')
      .select('id')
      .eq('name', 'FREE')
      .maybeSingle();

    await supabase.from('merchant_plans').insert([{
      merchant_id: newMerchant.id,
      ...(freePlan ? { plan_id: freePlan.id } : {}),
      plan_name: 'FREE',
      links_used: 0,
      cycle_started_at: new Date().toISOString()
    }]);

    merchant = newMerchant;
    isNew = true;
  }

  return { merchant, isNew };
}

function sessionPayload(merchant, planName) {
  const token = jwt.sign(
    { id: merchant.id, email: merchant.email, role: 'merchant' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  return {
    token,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      api_key: merchant.api_key,
      referral_code: merchant.referral_code,
      plan_name: planName,
      developer_api_key_generated: !!merchant.developer_api_key
    }
  };
}

// Google Login via Supabase
router.post('/google', async (req, res) => {
  try {
    const { access_token } = req.body;

    if (!access_token) {
      return res.status(400).json({ success: false, message: 'Access token required' });
    }

    // Verify with Supabase
    const { data: userData, error: userError } = await supabase.auth.getUser(access_token);

    if (userError || !userData?.user) {
      return res.status(401).json({ success: false, message: 'Invalid Google token' });
    }

    const { email, user_metadata } = userData.user;
    const name = user_metadata?.full_name || user_metadata?.name || email.split('@')[0];

    const { merchant, isNew } = await findOrCreateMerchant(email, name);

    const { plan: effPlan } = await P.getMerchantPlan(merchant.id);

    return res.json({
      success: true,
      message: 'Login successful',
      data: sessionPayload(merchant, effPlan.name)
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ======================= EMAIL OTP (passwordless login + signup) =======================
const crypto = require('crypto');
const { sendMail, otpEmail, MailError } = require('../services/mail.service');

const OTP_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const ipHits = new Map();   // ip -> [timestamps]  (in-memory, ek instance)

const normEmail = (e) => String(e || '').trim().toLowerCase();
const otpHash = (email, code) => crypto.createHash('sha256').update(`${email}|${code}|${process.env.JWT_SECRET}`).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function ipLimited(ip, max, windowMs) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { ipHits.set(ip, arr); return true; }
  arr.push(now); ipHits.set(ip, arr); return false;
}

// Step 1: OTP bhejo. Naye aur purane dono users ke liye same response (account exist karta hai ya nahi, ye leak nahi hota)
router.post('/otp/send', async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    if (ipLimited(req.ip || 'x', 15, 60 * 60 * 1000)) return res.status(429).json({ success: false, code: 'RATE_LIMIT', message: 'Too many requests. Please try again later.' });

    const now = Date.now();
    const { data: recent } = await supabase.from('email_otps').select('created_at').eq('email', email).gte('created_at', new Date(now - 60 * 60 * 1000).toISOString());
    const list = recent || [];
    const last = list.reduce((m, r) => Math.max(m, new Date(r.created_at).getTime()), 0);
    if (last && now - last < OTP_RESEND_SECONDS * 1000) {
      const wait = Math.ceil((OTP_RESEND_SECONDS * 1000 - (now - last)) / 1000);
      return res.status(429).json({ success: false, code: 'RESEND_WAIT', message: `Please wait ${wait}s before requesting another code`, retry_after: wait });
    }
    if (list.length >= OTP_MAX_PER_HOUR) return res.status(429).json({ success: false, code: 'RATE_LIMIT', message: 'Too many codes requested for this email. Try again in an hour.' });

    const { data: existing } = await supabase.from('merchants').select('id, is_active').eq('email', email).maybeSingle();
    if (existing && existing.is_active === false) return res.status(403).json({ success: false, message: 'This account is disabled. Contact support.' });

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await supabase.from('email_otps').update({ used: true }).eq('email', email).eq('used', false);   // purane codes band
    const { data: row, error } = await supabase.from('email_otps').insert([{
      email, code_hash: otpHash(email, code), attempts: 0, used: false, expires_at: new Date(now + OTP_MINUTES * 60 * 1000).toISOString()
    }]).select().single();
    if (error) throw error;

    try {
      const mail = otpEmail(code, { isNew: !existing, minutes: OTP_MINUTES });
      await sendMail({ to: email, ...mail });
    } catch (e) {
      await supabase.from('email_otps').delete().eq('id', row.id);
      const notCfg = e instanceof MailError && e.code === 'MAIL_NOT_CONFIGURED';
      return res.status(notCfg ? 503 : 502).json({ success: false, code: e.code || 'MAIL_FAILED', message: notCfg ? 'Email login is not available right now.' : 'Could not send the email. Please try again.' });
    }
    return res.json({ success: true, message: 'Verification code sent to your email', data: { expires_in: OTP_MINUTES * 60, resend_after: OTP_RESEND_SECONDS } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Step 2: code verify -> login (purana user) ya signup (naya user). Same session response jaisa Google login.
router.post('/otp/verify', async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ success: false, message: 'Enter the 6-digit code' });
    if (ipLimited('v:' + (req.ip || 'x'), 40, 60 * 60 * 1000)) return res.status(429).json({ success: false, code: 'RATE_LIMIT', message: 'Too many attempts. Please try again later.' });

    const { data: rows } = await supabase.from('email_otps').select('*').eq('email', email).eq('used', false).order('created_at', { ascending: false }).limit(1);
    const otp = rows && rows[0];
    if (!otp || new Date(otp.expires_at) <= new Date()) return res.status(400).json({ success: false, code: 'OTP_EXPIRED', message: 'Code expired or not found. Request a new code.' });
    if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) {
      await supabase.from('email_otps').update({ used: true }).eq('id', otp.id);
      return res.status(429).json({ success: false, code: 'OTP_LOCKED', message: 'Too many wrong attempts. Request a new code.' });
    }
    if (!safeEq(otp.code_hash, otpHash(email, code))) {
      await supabase.from('email_otps').update({ attempts: Number(otp.attempts) + 1 }).eq('id', otp.id);
      const left = OTP_MAX_ATTEMPTS - Number(otp.attempts) - 1;
      return res.status(400).json({ success: false, code: 'OTP_INVALID', message: left > 0 ? `Wrong code. ${left} attempt${left > 1 ? 's' : ''} left.` : 'Wrong code. Request a new code.' });
    }
    // Ek code sirf ek baar (atomic claim)
    const { data: claimed } = await supabase.from('email_otps').update({ used: true }).eq('id', otp.id).eq('used', false).select();
    if (!claimed || !claimed.length) return res.status(400).json({ success: false, code: 'OTP_EXPIRED', message: 'Code already used. Request a new code.' });

    const rawName = String((req.body && req.body.name) || '').replace(/[<>]/g, '').trim().slice(0, 60);
    const name = rawName.length >= 2 ? rawName : email.split('@')[0].slice(0, 40);
    const { merchant, isNew } = await findOrCreateMerchant(email, name);
    if (merchant.is_active === false) return res.status(403).json({ success: false, message: 'This account is disabled. Contact support.' });

    const { plan } = await P.getMerchantPlan(merchant.id);
    return res.json({ success: true, message: isNew ? 'Account created' : 'Login successful', data: { ...sessionPayload(merchant, plan.name), is_new_user: isNew } });
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