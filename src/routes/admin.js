const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { adminMiddleware } = require('../middleware/auth');

// Get all merchants
router.get('/merchants', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('merchants')
      .select('id, name, email, api_key, commission, is_active, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Toggle merchant active/inactive
router.patch('/merchants/:id/toggle', adminMiddleware, async (req, res) => {
  try {
    const { data: merchant } = await supabase
      .from('merchants')
      .select('is_active')
      .eq('id', req.params.id)
      .single();

    const { error } = await supabase
      .from('merchants')
      .update({ is_active: !merchant.is_active })
      .eq('id', req.params.id);

    if (error) throw error;
    return res.json({ success: true, message: 'Merchant status updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get all transactions
router.get('/transactions', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('transactions')
      .select('*, merchants(name, email)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get pending withdrawals
router.get('/withdrawals', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('withdrawals')
      .select('*, merchants(name, email)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Approve withdrawal
router.patch('/withdrawals/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const { note } = req.body;

    const { error } = await supabase
      .from('withdrawals')
      .update({ status: 'approved', note })
      .eq('id', req.params.id);

    if (error) throw error;
    return res.json({ success: true, message: 'Withdrawal approved' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Reject withdrawal
router.patch('/withdrawals/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { note } = req.body;

    // Get withdrawal details
    const { data: withdrawal } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('id', req.params.id)
      .single();

    // Refund balance
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('merchant_id', withdrawal.merchant_id)
      .single();

    await supabase
      .from('wallets')
      .update({ balance: wallet.balance + withdrawal.amount })
      .eq('merchant_id', withdrawal.merchant_id);

    // Update status
    await supabase
      .from('withdrawals')
      .update({ status: 'rejected', note })
      .eq('id', req.params.id);

    return res.json({ success: true, message: 'Withdrawal rejected and balance refunded' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get/Update settings
router.get('/settings', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .single();

    if (error && error.code === 'PGRST116') {
      return res.json({ success: true, data: null, message: 'No settings found' });
    }

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/settings', adminMiddleware, async (req, res) => {
  try {
    const { fampay_upi, fampay_qr, commission, min_withdrawal } = req.body;

    const { data: existing } = await supabase
      .from('settings')
      .select('id')
      .single();

    if (existing) {
      await supabase
        .from('settings')
        .update({ fampay_upi, fampay_qr, commission, min_withdrawal, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('settings')
        .insert([{ fampay_upi, fampay_qr, commission, min_withdrawal }]);
    }

    return res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Dashboard stats
router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    const [merchants, transactions, withdrawals] = await Promise.all([
      supabase.from('merchants').select('id', { count: 'exact' }),
      supabase.from('transactions').select('amount, net_amount, commission'),
      supabase.from('withdrawals').select('amount').eq('status', 'pending')
    ]);

    const totalVolume = transactions.data?.reduce((sum, t) => sum + t.amount, 0) || 0;
    const totalCommission = transactions.data?.reduce((sum, t) => sum + t.commission, 0) || 0;
    const pendingWithdrawals = withdrawals.data?.reduce((sum, w) => sum + w.amount, 0) || 0;

    return res.json({
      success: true,
      data: {
        total_merchants: merchants.count || 0,
        total_transactions: transactions.data?.length || 0,
        total_volume: totalVolume,
        total_commission: totalCommission,
        pending_withdrawals: pendingWithdrawals
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
