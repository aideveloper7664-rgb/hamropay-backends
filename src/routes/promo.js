const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { adminMiddleware } = require('../middleware/auth');

// Apply promo code
router.post('/apply', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: 'Promo code required' });
    }

    // Get promo code
    const { data: promo, error } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('is_active', true)
      .single();

    if (error || !promo) {
      return res.status(404).json({ success: false, message: 'Invalid promo code' });
    }

    // Check expiry
    if (promo.expires_at && new Date() > new Date(promo.expires_at)) {
      return res.status(400).json({ success: false, message: 'Promo code expired' });
    }

    // Check usage limit
    if (promo.usage_limit !== -1 && promo.used_count >= promo.usage_limit) {
      return res.status(400).json({ success: false, message: 'Promo code usage limit reached' });
    }

    // Check if merchant already used this code
    const { data: alreadyUsed } = await supabase
      .from('promo_usage')
      .select('id')
      .eq('promo_id', promo.id)
      .eq('merchant_id', req.merchant.id)
      .single();

    if (alreadyUsed) {
      return res.status(400).json({ success: false, message: 'You have already used this promo code' });
    }

    // Apply promo — add to Hamro Bonus
    const { data: bonus } = await supabase
      .from('hamro_bonus')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (bonus) {
      await supabase
        .from('hamro_bonus')
        .update({
          balance: bonus.balance + promo.value,
          updated_at: new Date().toISOString()
        })
        .eq('merchant_id', req.merchant.id);
    } else {
      await supabase
        .from('hamro_bonus')
        .insert([{ merchant_id: req.merchant.id, balance: promo.value }]);
    }

    // Record usage
    await supabase.from('promo_usage').insert([{
      promo_id: promo.id,
      merchant_id: req.merchant.id
    }]);

    // Update used count
    await supabase
      .from('promo_codes')
      .update({ used_count: promo.used_count + 1 })
      .eq('id', promo.id);

    return res.json({
      success: true,
      message: `Promo code applied! ₹${promo.value} added to Hamro Bonus`,
      data: { value: promo.value, type: promo.type }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get bonus balance
router.get('/bonus', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hamro_bonus')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error && error.code === 'PGRST116') {
      return res.json({ success: true, data: { balance: 0 } });
    }

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Convert Hamro Bonus to Hamro Credit
router.post('/bonus/convert-to-credit', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    // Get bonus balance
    const { data: bonus } = await supabase
      .from('hamro_bonus')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (!bonus || bonus.balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient Hamro Bonus balance' });
    }

    // Deduct bonus
    await supabase
      .from('hamro_bonus')
      .update({ balance: bonus.balance - amount, updated_at: new Date().toISOString() })
      .eq('merchant_id', req.merchant.id);

    // Add to Hamro Credit
    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    await supabase
      .from('hamro_credits')
      .update({
        balance: (credit?.balance || 0) + amount,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    await supabase.from('credit_transactions').insert([{
      merchant_id: req.merchant.id,
      type: 'purchase',
      amount,
      note: `Converted ₹${amount} from Hamro Bonus to Hamro Credit`
    }]);

    return res.json({
      success: true,
      message: `₹${amount} converted from Hamro Bonus to Hamro Credit`,
      data: { converted: amount }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Convert Hamro Cash to Hamro Credit
router.post('/cash/convert-to-credit', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    // Get wallet balance
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient Hamro Cash balance' });
    }

    // Deduct from wallet
    await supabase
      .from('wallets')
      .update({
        balance: wallet.balance - amount,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    // Add to Hamro Credit
    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    await supabase
      .from('hamro_credits')
      .update({
        balance: (credit?.balance || 0) + amount,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    await supabase.from('credit_transactions').insert([{
      merchant_id: req.merchant.id,
      type: 'purchase',
      amount,
      note: `Converted ₹${amount} from Hamro Cash to Hamro Credit`
    }]);

    return res.json({
      success: true,
      message: `₹${amount} converted from Hamro Cash to Hamro Credit`,
      data: { converted: amount }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin — create promo code
router.post('/admin/create', adminMiddleware, async (req, res) => {
  try {
    const { code, type, value, usage_limit, expires_at } = req.body;

    if (!code || !type || !value) {
      return res.status(400).json({ success: false, message: 'code, type, value required' });
    }

    const { data, error } = await supabase
      .from('promo_codes')
      .insert([{
        code: code.toUpperCase(),
        type,
        value,
        usage_limit: usage_limit || 1,
        expires_at: expires_at || null
      }])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ success: false, message: 'Promo code already exists' });
      }
      throw error;
    }

    return res.json({ success: true, message: 'Promo code created', data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin — list promo codes
router.get('/admin/list', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin — toggle promo code
router.patch('/admin/:id/toggle', adminMiddleware, async (req, res) => {
  try {
    const { data: promo } = await supabase
      .from('promo_codes')
      .select('is_active')
      .eq('id', req.params.id)
      .single();

    await supabase
      .from('promo_codes')
      .update({ is_active: !promo.is_active })
      .eq('id', req.params.id);

    return res.json({ success: true, message: 'Promo code updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;