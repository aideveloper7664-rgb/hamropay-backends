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
async function findOrCreateMerchant(email, name, passwordHash) {
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
        password: passwordHash || await bcrypt.hash(uuidv4(), 10),
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
    if (merchant.is_active === false) return res.status(403).json({ success: false, message: 'This account is disabled. Contact support.' });

    const { plan: effPlan } = await P.getMerchantPlan(merchant.id);

    return res.json({
      success: true,
      message: 'Login successful',
      data: { ...sessionPayload(merchant, effPlan.name), is_new_user: isNew }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ======================= PASSWORD + EMAIL OTP (signup / login / forgot) =======================
// Signup : name + email + password + confirm  -> OTP -> account banta hai (OTP se pehle kuch nahi banta)
// Login  : email + password (sahi ho tabhi) -> OTP -> session
// Google : /auth/google (direct, OTP nahi)
const crypto = require('crypto');
const { sendMail, otpEmail, MailError } = require('../services/mail.service');

const OTP_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;
const HOUR = 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const ipHits = new Map();   // key -> [timestamps]  (in-memory, ek instance)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);   // timing barabar rakhne ke liye

const normEmail = (e) => String(e || '').trim().toLowerCase();
const otpHash = (email, code) => crypto.createHash('sha256').update(`${email}|${code}|${process.env.JWT_SECRET}`).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cleanName = (n) => String(n || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
const bad = (res, message, status = 400, extra = {}) => res.status(status).json({ success: false, message, ...extra });

function ipLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (ipHits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { ipHits.set(key, arr); return true; }
  arr.push(now); ipHits.set(key, arr); return false;
}

function checkPassword(pw, confirm) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (max 72 characters)';
  if (confirm !== undefined && confirm !== pw) return 'Passwords do not match';
  return null;
}

// OTP banao + email karo. Rate limits yahin. Fail par response bhej deta hai aur false deta hai.
async function issueOtp(req, res, email, purpose, payload) {
  if (ipLimited('s:' + (req.ip || 'x'), 20, HOUR)) { bad(res, 'Too many requests. Please try again later.', 429, { code: 'RATE_LIMIT' }); return false; }
  const now = Date.now();
  const { data: recent } = await supabase.from('email_otps').select('created_at').eq('email', email).gte('created_at', new Date(now - HOUR).toISOString());
  const list = recent || [];
  const last = list.reduce((m, r) => Math.max(m, new Date(r.created_at).getTime()), 0);
  if (last && now - last < OTP_RESEND_SECONDS * 1000) {
    const wait = Math.ceil((OTP_RESEND_SECONDS * 1000 - (now - last)) / 1000);
    bad(res, `Please wait ${wait}s before requesting another code`, 429, { code: 'RESEND_WAIT', retry_after: wait }); return false;
  }
  if (list.length >= OTP_MAX_PER_HOUR) { bad(res, 'Too many codes requested for this email. Try again in an hour.', 429, { code: 'RATE_LIMIT' }); return false; }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await supabase.from('email_otps').update({ used: true }).eq('email', email).eq('used', false);   // purane codes band
  const { data: row, error } = await supabase.from('email_otps').insert([{
    email, purpose, payload: payload || null, code_hash: otpHash(email, code), attempts: 0, used: false,
    expires_at: new Date(now + OTP_MINUTES * 60 * 1000).toISOString()
  }]).select().single();
  if (error) throw error;

  try {
    await sendMail({ to: email, ...otpEmail(code, { purpose, minutes: OTP_MINUTES }) });
  } catch (e) {
    await supabase.from('email_otps').delete().eq('id', row.id);
    const notCfg = e instanceof MailError && e.code === 'MAIL_NOT_CONFIGURED';
    bad(res, notCfg ? 'Email verification is not available right now.' : 'Could not send the email. Please try again.', notCfg ? 503 : 502, { code: e.code || 'MAIL_FAILED' });
    return false;
  }
  return true;
}

const sentOk = (res) => res.json({ success: true, message: 'Verification code sent to your email', data: { expires_in: OTP_MINUTES * 60, resend_after: OTP_RESEND_SECONDS } });

// Code check (expiry, attempts, single use). Ok -> { otp }, nahi to response bhej kar { done:true }
async function consumeOtp(req, res, email, code, purpose) {
  if (!EMAIL_RE.test(email)) { bad(res, 'Enter a valid email address'); return { done: true }; }
  if (!/^\d{6}$/.test(code)) { bad(res, 'Enter the 6-digit code'); return { done: true }; }
  if (ipLimited('v:' + (req.ip || 'x'), 40, HOUR)) { bad(res, 'Too many attempts. Please try again later.', 429, { code: 'RATE_LIMIT' }); return { done: true }; }

  const { data: rows } = await supabase.from('email_otps').select('*').eq('email', email).eq('purpose', purpose).eq('used', false);
  const otp = (rows || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (!otp || new Date(otp.expires_at) <= new Date()) { bad(res, 'Code expired or not found. Request a new code.', 400, { code: 'OTP_EXPIRED' }); return { done: true }; }
  if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) {
    await supabase.from('email_otps').update({ used: true }).eq('id', otp.id);
    bad(res, 'Too many wrong attempts. Request a new code.', 429, { code: 'OTP_LOCKED' }); return { done: true };
  }
  if (!safeEq(otp.code_hash, otpHash(email, code))) {
    await supabase.from('email_otps').update({ attempts: Number(otp.attempts) + 1 }).eq('id', otp.id);
    const left = OTP_MAX_ATTEMPTS - Number(otp.attempts) - 1;
    bad(res, left > 0 ? `Wrong code. ${left} attempt${left > 1 ? 's' : ''} left.` : 'Wrong code. Request a new code.', 400, { code: 'OTP_INVALID' }); return { done: true };
  }
  const { data: claimed } = await supabase.from('email_otps').update({ used: true }).eq('id', otp.id).eq('used', false).select();   // atomic: ek code ek baar
  if (!claimed || !claimed.length) { bad(res, 'Code already used. Request a new code.', 400, { code: 'OTP_EXPIRED' }); return { done: true }; }
  await supabase.from('email_otps').delete().eq('id', otp.id);   // use ho gaya -> hata do (cooldown/hourly count me ginti nahi hogi)
  return { otp };
}

async function finishLogin(res, merchant, message, extra = {}) {
  const { plan } = await P.getMerchantPlan(merchant.id);
  return res.json({ success: true, message, data: { ...sessionPayload(merchant, plan.name), ...extra } });
}

// ---------- SIGNUP ----------
// Step 1: details lo, check karo, OTP bhejo. Account abhi NAHI banta.
router.post('/register/start', async (req, res) => {
  try {
    const b = req.body || {};
    const name = cleanName(b.name);
    const email = normEmail(b.email);
    if (name.length < 2) return bad(res, 'Enter your full name');
    if (!EMAIL_RE.test(email) || email.length > 254) return bad(res, 'Enter a valid email address');
    const pwErr = checkPassword(b.password, b.confirm_password);
    if (pwErr) return bad(res, pwErr);

    const { data: existing } = await supabase.from('merchants').select('id').eq('email', email).maybeSingle();
    if (existing) return bad(res, 'An account with this email already exists. Please log in.', 409, { code: 'EMAIL_EXISTS' });

    const password_hash = await bcrypt.hash(b.password, 10);
    if (!(await issueOtp(req, res, email, 'signup', { name, password_hash }))) return;
    return sentOk(res);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Step 2: OTP sahi -> tab jaake account banta hai + login
router.post('/register/verify', async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim();
    const r = await consumeOtp(req, res, email, code, 'signup');
    if (r.done) return;
    const pl = r.otp.payload || {};
    if (!pl.name || !pl.password_hash) return bad(res, 'Signup session expired. Please start again.', 400, { code: 'OTP_EXPIRED' });

    const { data: existing } = await supabase.from('merchants').select('id').eq('email', email).maybeSingle();
    if (existing) return bad(res, 'An account with this email already exists. Please log in.', 409, { code: 'EMAIL_EXISTS' });

    const { merchant } = await findOrCreateMerchant(email, pl.name, pl.password_hash);
    return finishLogin(res, merchant, 'Account created', { is_new_user: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- LOGIN ----------
// Step 1: email + password check. Sahi ho tabhi OTP jaata hai.
router.post('/login/start', async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    if (!EMAIL_RE.test(email) || !password) return bad(res, 'Enter your email and password');
    if (ipLimited('l:' + (req.ip || 'x'), 30, HOUR) || ipLimited('le:' + email, 10, HOUR)) return bad(res, 'Too many login attempts. Please try again later.', 429, { code: 'RATE_LIMIT' });

    const { data: merchant } = await supabase.from('merchants').select('*').eq('email', email).maybeSingle();
    const ok = await bcrypt.compare(password, merchant && merchant.password ? merchant.password : DUMMY_HASH);
    if (!merchant || !ok) return bad(res, "Invalid email or password. If you signed up with Google, use 'Forgot password' to set a password.", 401, { code: 'INVALID_CREDENTIALS' });
    if (merchant.is_active === false) return bad(res, 'This account is disabled. Contact support.', 403);

    if (!(await issueOtp(req, res, email, 'login', null))) return;
    return sentOk(res);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Step 2: OTP -> login
router.post('/login/verify', async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim();
    const r = await consumeOtp(req, res, email, code, 'login');
    if (r.done) return;
    const { data: merchant } = await supabase.from('merchants').select('*').eq('email', email).maybeSingle();
    if (!merchant) return bad(res, 'Account not found', 404);
    if (merchant.is_active === false) return bad(res, 'This account is disabled. Contact support.', 403);
    return finishLogin(res, merchant, 'Login successful', { is_new_user: false });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- RESEND (signup / login / reset) ----------
// Sirf tab jab pehle us email+purpose ka step-1 ho chuka ho (isse random logo ko email bhejne ka tool nahi ban sakta)
router.post('/resend', async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    const purpose = String((req.body && req.body.purpose) || '');
    if (!EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address');
    if (!['signup', 'login', 'reset'].includes(purpose)) return bad(res, 'Invalid request');

    const { data: rows } = await supabase.from('email_otps').select('*').eq('email', email).eq('purpose', purpose).gte('created_at', new Date(Date.now() - HOUR).toISOString());
    const prev = (rows || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!prev) {
      if (purpose === 'reset') return sentOk(res);   // account hai ya nahi, leak nahi
      return bad(res, 'Session expired. Please start again.', 400, { code: 'START_AGAIN' });
    }
    if (purpose === 'signup') {
      const { data: existing } = await supabase.from('merchants').select('id').eq('email', email).maybeSingle();
      if (existing) return bad(res, 'An account with this email already exists. Please log in.', 409, { code: 'EMAIL_EXISTS' });
    }
    if (!(await issueOtp(req, res, email, purpose, prev.payload || null))) return;
    return sentOk(res);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- FORGOT PASSWORD (Google/purane accounts ke liye password set karne ka bhi yahi raasta) ----------
router.post('/forgot/start', async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    if (!EMAIL_RE.test(email) || email.length > 254) return bad(res, 'Enter a valid email address');
    const { data: merchant } = await supabase.from('merchants').select('id, is_active').eq('email', email).maybeSingle();
    if (!merchant || merchant.is_active === false) {
      if (ipLimited('s:' + (req.ip || 'x'), 20, HOUR)) return bad(res, 'Too many requests. Please try again later.', 429, { code: 'RATE_LIMIT' });
      return sentOk(res);   // generic
    }
    if (!(await issueOtp(req, res, email, 'reset', null))) return;
    return sentOk(res);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/forgot/verify', async (req, res) => {
  try {
    const b = req.body || {};
    const email = normEmail(b.email);
    const code = String(b.code || '').trim();
    const pwErr = checkPassword(b.new_password, b.confirm_password);
    if (pwErr) return bad(res, pwErr);   // code burn hone se pehle
    const r = await consumeOtp(req, res, email, code, 'reset');
    if (r.done) return;
    const hash = await bcrypt.hash(b.new_password, 10);
    const { data: upd } = await supabase.from('merchants').update({ password: hash }).eq('email', email).select();
    if (!upd || !upd.length) return bad(res, 'Account not found', 404);
    return res.json({ success: true, message: 'Password updated. You can log in now.' });
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
