const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { adminMiddleware } = require('../middleware/auth');
const gmailService = require('../services/gmail.service');

// Get credit balance
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hamro_credits')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error && error.code === 'PGRST116') {
      // Create credit account with 20 free credits
      const { data: newCredit } = await supabase
        .from('hamro_credits')
        .insert([{ merchant_id: req.merchant.id, balance: 20 }])
        .select()
        .single();
      return res.json({ success: true, data: newCredit });
    }

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Purchase credits via own gateway
router.post('/purchase', authMiddleware, async (req, res) => {
  try {
    const { amount, utr } = req.body;

    if (!amount || !utr) {
      return res.status(400).json({ success: false, message: 'Amount and UTR required' });
    }

    // Check UTR already used
    const { data: existingUtr } = await supabase
      .from('credit_transactions')
      .select('id')
      .eq('utr', utr)
      .single();

    if (existingUtr) {
      return res.status(400).json({ success: false, message: 'UTR already used' });
    }

    // Verify UTR via admin Gmail
    const verified = await gmailService.verifyUTR(utr, amount);
    if (!verified) {
      return res.status(400).json({ success: false, message: 'Payment not found. Check UTR and try again.' });
    }

    // Get current credit balance
    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance, total_purchased')
      .eq('merchant_id', req.merchant.id)
      .single();

    const currentBalance = credit?.balance || 0;
    const currentPurchased = credit?.total_purchased || 0;

    // Add credits (1 INR = 1 Credit)
    if (credit) {
      await supabase
        .from('hamro_credits')
        .update({
          balance: currentBalance + amount,
          total_purchased: currentPurchased + amount,
          updated_at: new Date().toISOString()
        })
        .eq('merchant_id', req.merchant.id);
    } else {
      await supabase
        .from('hamro_credits')
        .insert([{
          merchant_id: req.merchant.id,
          balance: 20 + amount,
          total_purchased: amount
        }]);
    }

    // Save credit transaction
    await supabase
      .from('credit_transactions')
      .insert([{
        merchant_id: req.merchant.id,
        type: 'purchase',
        amount,
        utr,
        note: `Purchased ${amount} Hamro Credits`
      }]);

    return res.json({
      success: true,
      message: `${amount} Hamro Credits added successfully!`,
      data: { credits_added: amount, new_balance: currentBalance + amount }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get credit transactions history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('credit_transactions')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin — manually add credits
router.post('/admin/add', adminMiddleware, async (req, res) => {
  try {
    const { merchant_id, amount, note } = req.body;

    if (!merchant_id || !amount) {
      return res.status(400).json({ success: false, message: 'merchant_id and amount required' });
    }

    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance')
      .eq('merchant_id', merchant_id)
      .single();

    if (credit) {
      await supabase
        .from('hamro_credits')
        .update({
          balance: credit.balance + amount,
          updated_at: new Date().toISOString()
        })
        .eq('merchant_id', merchant_id);
    } else {
      await supabase
        .from('hamro_credits')
        .insert([{ merchant_id, balance: amount }]);
    }

    await supabase
      .from('credit_transactions')
      .insert([{
        merchant_id,
        type: 'purchase',
        amount,
        note: note || `Admin added ${amount} credits`
      }]);

    return res.json({ success: true, message: `${amount} credits added` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Deduct credits (internal use)
const deductCredits = async (merchant_id, amount, order_id, note) => {
  const { data: credit } = await supabase
    .from('hamro_credits')
    .select('balance, total_spent')
    .eq('merchant_id', merchant_id)
    .single();

  if (!credit || credit.balance < amount) {
    throw new Error('Insufficient Hamro Credits');
  }

  await supabase
    .from('hamro_credits')
    .update({
      balance: credit.balance - amount,
      total_spent: (credit.total_spent || 0) + amount,
      updated_at: new Date().toISOString()
    })
    .eq('merchant_id', merchant_id);

  await supabase
    .from('credit_transactions')
    .insert([{
      merchant_id,
      type: 'deduct',
      amount,
      order_id,
      note: note || `Commission deducted`
    }]);
};

module.exports = router;
module.exports.deductCredits = deductCredits;