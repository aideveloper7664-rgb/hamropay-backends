const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Get referral info
router.get('/info', authMiddleware, async (req, res) => {
  try {
    const { data: merchant } = await supabase
      .from('merchants')
      .select('referral_code')
      .eq('id', req.merchant.id)
      .single();

    const { data: referrals } = await supabase
      .from('referrals')
      .select('*, merchants!referred_id(name, email, created_at)')
      .eq('referrer_id', req.merchant.id);

    const totalEarnings = referrals?.reduce((sum, r) => sum + (r.cashback_amount || 0), 0) || 0;
    const totalReferrals = referrals?.length || 0;
    const successfulReferrals = referrals?.filter(r => r.status === 'completed').length || 0;

    return res.json({
      success: true,
      data: {
        referral_code: merchant.referral_code,
        referral_url: `${process.env.FRONTEND_URL}/register?ref=${merchant.referral_code}`,
        total_referrals: totalReferrals,
        successful_referrals: successfulReferrals,
        total_earnings: totalEarnings,
        referrals: referrals || []
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Process referral cashback (called after first credit purchase)
const processReferralCashback = async (merchant_id, purchase_amount) => {
  try {
    // Check if this merchant was referred
    const { data: merchant } = await supabase
      .from('merchants')
      .select('referred_by')
      .eq('id', merchant_id)
      .single();

    if (!merchant?.referred_by) return;

    // Check if referral already processed
    const { data: referral } = await supabase
      .from('referrals')
      .select('*')
      .eq('referrer_id', merchant.referred_by)
      .eq('referred_id', merchant_id)
      .eq('status', 'pending')
      .single();

    if (!referral) return;

    // Calculate 25% cashback
    const cashback = purchase_amount * 0.25;

    // Add cashback credits to referrer
    const { data: referrerCredit } = await supabase
      .from('hamro_credits')
      .select('balance')
      .eq('merchant_id', merchant.referred_by)
      .single();

    await supabase
      .from('hamro_credits')
      .update({
        balance: (referrerCredit?.balance || 0) + cashback,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', merchant.referred_by);

    // Save credit transaction
    await supabase.from('credit_transactions').insert([{
      merchant_id: merchant.referred_by,
      type: 'purchase',
      amount: cashback,
      note: `25% referral cashback from referred merchant's first deposit`
    }]);

    // Update referral status
    await supabase
      .from('referrals')
      .update({
        status: 'completed',
        cashback_amount: cashback
      })
      .eq('id', referral.id);

  } catch (err) {
    console.error('Referral cashback error:', err.message);
  }
};

module.exports = router;
module.exports.processReferralCashback = processReferralCashback;