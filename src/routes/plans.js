const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const P = require('../services/plans.service');

// Public: 7 plans ki poori list (pricing page)
router.get('/', (req, res) => {
  return res.json({ success: true, data: P.ORDER.map((k) => P.publicPlan(P.PLANS[k])) });
});

// Merchant: abhi ka plan + is cycle ka usage
router.get('/current', authMiddleware, async (req, res) => {
  try {
    const { plan, expired, row, expires_at } = await P.getMerchantPlan(req.merchant.id);
    const { urls } = await P.listWebhookUrls(req.merchant);
    const { data: accts } = await supabase.from('cashier_accounts').select('type').eq('merchant_id', req.merchant.id);
    const used = { fampay: 0, paytm_mid: 0, amazon: 0 };
    (accts || []).forEach((a) => { if (used[a.type] !== undefined) used[a.type] += 1; });
    return res.json({
      success: true,
      data: {
        plan: P.publicPlan(plan),
        expires_at,
        expired_recently: expired,
        usage: {
          links_used: row ? Number(row.links_used) || 0 : 0,
          links_limit: plan.links_per_month,
          webhooks_used: urls.length,
          webhooks_limit: plan.webhooks,
          accounts_used: used
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Upgrade / renew via Hamro Cash (wallet balance). Sab plans 30 din ke.
router.post('/upgrade', authMiddleware, async (req, res) => {
  try {
    const key = String((req.body && (req.body.plan_id || req.body.plan || req.body.plan_name)) || '').trim();
    if (!key) return res.status(400).json({ success: false, message: 'plan_id required' });

    // plan_id = plan ka naam (BASIC...) ya plans table ki UUID
    let target = P.lookup(key);
    if (!target) {
      const { data: byId } = await supabase.from('plans').select('id, name').eq('id', key).maybeSingle();
      if (byId) target = P.lookup(byId.name);
    }
    if (!target) return res.status(404).json({ success: false, message: 'Plan not found' });

    const can = await P.checkCanBuy(req.merchant.id, target);
    if (!can.ok) return res.status(400).json({ success: false, message: can.message });

    const { data: wallet } = await supabase.from('wallets').select('balance').eq('merchant_id', req.merchant.id).maybeSingle();
    const balance = wallet ? Number(wallet.balance) : 0;
    if (balance < target.price) {
      return res.status(400).json({ success: false, message: `Insufficient Hamro Cash. Need ₹${target.price}, have ₹${balance}` });
    }

    // Paisa kaato (balance badla ho to fail -> double spend nahi)
    const { data: paid } = await supabase.from('wallets')
      .update({ balance: Math.round((balance - target.price) * 100) / 100, updated_at: new Date().toISOString() })
      .eq('merchant_id', req.merchant.id).eq('balance', wallet.balance).select();
    if (!paid || !paid.length) {
      return res.status(409).json({ success: false, message: 'Balance changed, please try again.' });
    }

    let activated;
    try {
      activated = await P.activatePlan(req.merchant.id, target);
    } catch (e) {
      // Plan set na ho paya -> paisa wapas
      await supabase.from('wallets').update({ balance: balance, updated_at: new Date().toISOString() }).eq('merchant_id', req.merchant.id);
      return res.status(500).json({ success: false, message: 'Could not activate the plan. Your Hamro Cash was not charged.' });
    }
    const newExpiry = activated.expires_at;

    return res.json({
      success: true,
      message: `${target.name} plan activated for ${P.DURATION_DAYS} days!`,
      data: { plan_name: target.name, expires_at: newExpiry, charged: target.price }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Purana helper (wallet.js use karta hai): withdraw limit + link limit check
const checkPlanLimits = async (merchant_id, action) => {
  try {
    if (action === 'create_link') {
      const { plan, row } = await P.getMerchantPlan(merchant_id);
      if (plan.links_per_month !== null && row && Number(row.links_used) >= plan.links_per_month) {
        return { allowed: false, message: `Payment link limit reached (${plan.links_per_month}/month). Upgrade your plan.` };
      }
      return { allowed: true, plan };
    }
    if (action === 'withdraw') {
      const { data: mp } = await supabase.from('merchant_plans').select('*, plans(*)').eq('merchant_id', merchant_id).maybeSingle();
      const weeklyLimit = mp && mp.plans && mp.plans.withdrawal_per_week !== undefined && mp.plans.withdrawal_per_week !== null ? mp.plans.withdrawal_per_week : -1;
      if (weeklyLimit !== -1) {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const { data: weekly } = await supabase.from('withdrawals').select('id').eq('merchant_id', merchant_id).gte('created_at', weekStart.toISOString());
        if (weekly && weekly.length >= weeklyLimit) {
          return { allowed: false, message: `Weekly withdrawal limit reached (${weeklyLimit}/week). Upgrade your plan.` };
        }
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
};

module.exports = router;
module.exports.checkPlanLimits = checkPlanLimits;
