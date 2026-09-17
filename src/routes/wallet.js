const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Get Wallet Balance
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const { data: wallet, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      data: {
        balance: wallet.balance || 0,
        total_earned: wallet.total_earned || 0
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
    const { amount, upi_id } = req.body;

    if (!amount || !upi_id) {
      return res.status(400).json({ success: false, message: 'Amount and UPI ID required' });
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
        upi_id,
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
        upi_id,
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