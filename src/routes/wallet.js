const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { checkPlanLimits } = require('./plans');

// Get Wallet Balance
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const { data: wallet, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error) throw error;

    // Get plan info
    const { data: merchantPlan } = await supabase
      .from('merchant_plans')
      .select('*, plans(*)')
      .eq('merchant_id', req.merchant.id)
      .single();

    return res.json({
      success: true,
      data: {
        balance: wallet.balance || 0,
        total_earned: wallet.total_earned || 0,
        wallet_limit: merchantPlan?.plans?.wallet_limit || 500,
        plan_name: merchantPlan?.plan_name || 'Blaze'
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get Transactions
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.json({ success: true, data: transactions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Withdraw Request
router.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount, upi_id, method, bank_name, account_number, ifsc_code, account_holder } = req.body;

    if (!amount) {
      return res.status(400).json({ success: false, message: 'Amount required' });
    }

    if (method === 'upi' && !upi_id) {
      return res.status(400).json({ success: false, message: 'UPI ID required' });
    }

    if (method === 'bank' && (!bank_name || !account_number || !ifsc_code || !account_holder)) {
      return res.status(400).json({ success: false, message: 'All bank details required' });
    }

    // Check plan withdrawal limits
    const limitCheck = await checkPlanLimits(req.merchant.id, 'withdraw');
    if (!limitCheck.allowed) {
      return res.status(400).json({ success: false, message: limitCheck.message });
    }

    // Get settings for min withdrawal
    const { data: settings } = await supabase
      .from('settings')
      .select('min_withdrawal')
      .single();

    const minWithdrawal = settings?.min_withdrawal || 100;

    if (amount < minWithdrawal) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal amount is ₹${minWithdrawal}`
      });
    }

    // Check wallet balance
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (walletError) throw walletError;

    if (wallet.balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Create withdrawal request
    const { data: withdrawal, error } = await supabase
      .from('withdrawals')
      .insert([{
        merchant_id: req.merchant.id,
        amount,
        upi_id: method === 'upi' ? upi_id : null,
        method: method || 'upi',
        bank_name: method === 'bank' ? bank_name : null,
        account_number: method === 'bank' ? account_number : null,
        ifsc_code: method === 'bank' ? ifsc_code : null,
        account_holder: method === 'bank' ? account_holder : null,
        status: 'pending'
      }])
      .select()
      .single();

    if (error) throw error;

    // Deduct balance
    await supabase
      .from('wallets')
      .update({
        balance: wallet.balance - amount,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    return res.json({
      success: true,
      message: 'Withdrawal request submitted',
      data: {
        withdrawal_id: withdrawal.id,
        amount,
        method: method || 'upi',
        status: 'pending'
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get Withdrawal History
router.get('/withdrawals', authMiddleware, async (req, res) => {
  try {
    const { data: withdrawals, error } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data: withdrawals });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;