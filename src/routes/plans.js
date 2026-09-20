const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { adminMiddleware } = require('../middleware/auth');

// Get all plans
router.get('/list', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get merchant current plan
router.get('/current', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('merchant_plans')
      .select('*, plans(*)')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error && error.code === 'PGRST116') {
      // Create default Blaze plan
      const { data: blazePlan } = await supabase
        .from('plans')
        .select('*')
        .eq('name', 'Blaze')
        .single();

      const { data: newPlan } = await supabase
        .from('merchant_plans')
        .insert([{
          merchant_id: req.merchant.id,
          plan_id: blazePlan.id,
          plan_name: 'Blaze',
          expires_at: null
        }])
        .select('*, plans(*)')
        .single();

      return res.json({ success: true, data: newPlan });
    }

    if (error) throw error;

    // Check if plan expired
    if (data.expires_at && new Date() > new Date(data.expires_at)) {
      // Downgrade to Blaze
      const { data: blazePlan } = await supabase
        .from('plans')
        .select('*')
        .eq('name', 'Blaze')
        .single();

      await supabase
        .from('merchant_plans')
        .update({
          plan_id: blazePlan.id,
          plan_name: 'Blaze',
          expires_at: null,
          links_used: 0,
          withdrawals_used: 0
        })
        .eq('merchant_id', req.merchant.id);

      await supabase
        .from('merchants')
        .update({ plan_name: 'Blaze', plan_expires_at: null })
        .eq('id', req.merchant.id);

      return res.json({ success: true, data: { ...data, plan_name: 'Blaze', plans: blazePlan } });
    }

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Upgrade plan via Hamro Cash
router.post('/upgrade', authMiddleware, async (req, res) => {
  try {
    const { plan_id } = req.body;

    if (!plan_id) {
      return res.status(400).json({ success: false, message: 'plan_id required' });
    }

    // Get plan details
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    if (planError || !plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (plan.price === 0) {
      return res.status(400).json({ success: false, message: 'Already on free plan' });
    }

    // Check Hamro Cash balance
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (!wallet || wallet.balance < plan.price) {
      return res.status(400).json({
        success: false,
        message: `Insufficient Hamro Cash. Need ₹${plan.price}, have ₹${wallet?.balance || 0}`
      });
    }

    // Deduct from Hamro Cash
    await supabase
      .from('wallets')
      .update({
        balance: wallet.balance - plan.price,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    // Set expiry
    const expiresAt = new Date(Date.now() + plan.duration_days * 24 * 60 * 60 * 1000).toISOString();

    // Update merchant plan
    const { data: existing } = await supabase
      .from('merchant_plans')
      .select('id')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (existing) {
      await supabase
        .from('merchant_plans')
        .update({
          plan_id: plan.id,
          plan_name: plan.name,
          expires_at: expiresAt,
          links_used: 0,
          withdrawals_used: 0
        })
        .eq('merchant_id', req.merchant.id);
    } else {
      await supabase
        .from('merchant_plans')
        .insert([{
          merchant_id: req.merchant.id,
          plan_id: plan.id,
          plan_name: plan.name,
          expires_at: expiresAt
        }]);
    }

    await supabase
      .from('merchants')
      .update({ plan_name: plan.name, plan_expires_at: expiresAt })
      .eq('id', req.merchant.id);

    return res.json({
      success: true,
      message: `Upgraded to ${plan.name} plan successfully!`,
      data: { plan_name: plan.name, expires_at: expiresAt }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin — update plan
router.post('/admin/update', adminMiddleware, async (req, res) => {
  try {
    const { plan_id, name, price, links_limit, wallet_limit, commission, link_expiry_days, withdrawal_per_week, webhooks_limit, premium_themes, store_access, hide_qr } = req.body;

    const { error } = await supabase
      .from('plans')
      .update({ name, price, links_limit, wallet_limit, commission, link_expiry_days, withdrawal_per_week, webhooks_limit, premium_themes, store_access, hide_qr })
      .eq('id', plan_id);

    if (error) throw error;
    return res.json({ success: true, message: 'Plan updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin — assign plan to merchant
router.post('/admin/assign', adminMiddleware, async (req, res) => {
  try {
    const { merchant_id, plan_id } = req.body;

    const { data: plan } = await supabase
      .from('plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    const expiresAt = plan.duration_days > 0
      ? new Date(Date.now() + plan.duration_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const { data: existing } = await supabase
      .from('merchant_plans')
      .select('id')
      .eq('merchant_id', merchant_id)
      .single();

    if (existing) {
      await supabase
        .from('merchant_plans')
        .update({ plan_id, plan_name: plan.name, expires_at: expiresAt, links_used: 0, withdrawals_used: 0 })
        .eq('merchant_id', merchant_id);
    } else {
      await supabase
        .from('merchant_plans')
        .insert([{ merchant_id, plan_id, plan_name: plan.name, expires_at: expiresAt }]);
    }

    await supabase
      .from('merchants')
      .update({ plan_name: plan.name, plan_expires_at: expiresAt })
      .eq('id', merchant_id);

    return res.json({ success: true, message: `Plan assigned successfully` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Check plan limits (middleware helper)
const checkPlanLimits = async (merchant_id, action) => {
  const { data: merchantPlan } = await supabase
    .from('merchant_plans')
    .select('*, plans(*)')
    .eq('merchant_id', merchant_id)
    .single();

  if (!merchantPlan) return { allowed: true };

  const plan = merchantPlan.plans;

  if (action === 'create_link') {
    if (plan.links_limit !== -1 && merchantPlan.links_used >= plan.links_limit) {
      return { allowed: false, message: `Payment link limit reached (${plan.links_limit}/month). Upgrade your plan.` };
    }
  }

  if (action === 'withdraw') {
    const weeklyLimit = plan.withdrawal_per_week;
    if (weeklyLimit !== -1) {
      // Check withdrawals this week
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const { data: weeklyWithdrawals } = await supabase
        .from('withdrawals')
        .select('id')
        .eq('merchant_id', merchant_id)
        .gte('created_at', weekStart.toISOString());

      if (weeklyWithdrawals && weeklyWithdrawals.length >= weeklyLimit) {
        return { allowed: false, message: `Weekly withdrawal limit reached (${weeklyLimit}/week). Upgrade your plan.` };
      }
    }
  }

  if (action === 'check_wallet') {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('merchant_id', merchant_id)
      .single();

    if (plan.wallet_limit !== -1 && wallet && wallet.balance >= plan.wallet_limit) {
      return { allowed: false, message: `Wallet limit reached (₹${plan.wallet_limit}). Upgrade your plan.` };
    }
  }

  return { allowed: true, plan, merchantPlan };
};

module.exports = router;
module.exports.checkPlanLimits = checkPlanLimits;