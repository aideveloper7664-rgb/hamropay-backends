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

    // Find or create merchant
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
    }

    const { plan: effPlan } = await P.getMerchantPlan(merchant.id);

    // Generate JWT
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
          referral_code: merchant.referral_code,
          plan_name: effPlan.name,
          developer_api_key_generated: !!merchant.developer_api_key
        }
      }
    });
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