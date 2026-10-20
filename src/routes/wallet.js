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

// Payment History: har checkout (pending / timeout / cancelled / failed / success) + purani confirmed payments
// ?limit=100 (1-200)  ?before=<ISO created_at>  (agla page: response ka next_before)
router.get('/payments', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    let before = null;
    if (req.query.before) {
      before = new Date(String(req.query.before));
      if (isNaN(before.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid before date' });
      }
    }

    let sq = supabase.from('checkout_sessions').select('*')
      .eq('merchant_id', req.merchant.id)
      .eq('is_test', false)            // test-mode orders history me nahi dikhte
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    let tq = supabase.from('transactions').select('*')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (before) {
      sq = sq.lt('created_at', before.toISOString());
      tq = tq.lt('created_at', before.toISOString());
    }

    const [sRes, tRes] = await Promise.all([sq, tq]);
    if (sRes.error) throw sRes.error;
    if (tRes.error) throw tRes.error;
    const sessions = sRes.data || [];
    const txns = tRes.data || [];

    // Link titles
    const linkIds = [...new Set(sessions.map((x) => x.link_id).filter(Boolean))];
    const titles = {};
    if (linkIds.length) {
      const { data: links } = await supabase
        .from('payment_links').select('link_id, title')
        .eq('merchant_id', req.merchant.id).in('link_id', linkIds);
      (links || []).forEach((l) => { titles[l.link_id] = l.title; });
    }

    // transactions.order_id = orders.id (uuid): readable ORD_ code chahiye
    const orderUuids = [...new Set(txns.map((t) => t.order_id).filter(Boolean))];
    const orderCodes = {};
    if (orderUuids.length) {
      const { data: orders } = await supabase
        .from('orders').select('id, order_id')
        .eq('merchant_id', req.merchant.id).in('id', orderUuids);
      (orders || []).forEach((o) => { orderCodes[o.id] = o.order_id; });
    }

    const txnByUtr = new Map(txns.filter((t) => t.utr).map((t) => [t.utr, t]));
    const sessionUtrs = new Set(sessions.filter((x) => x.utr).map((x) => x.utr));
    const now = Date.now();

    const rows = sessions.map((x) => {
      let status;
      if (x.status === 'paid') status = 'success';
      else if (x.status === 'expired') status = 'timeout';
      else if (x.status === 'pending') status = new Date(x.expires_at).getTime() <= now ? 'timeout' : 'pending';
      else status = x.status; // cancelled | failed
      const t = x.status === 'paid' ? txnByUtr.get(x.utr) : null;
      return {
        id: x.id,
        order_id: x.order_id || x.session_id,
        link_id: x.link_id,
        link_title: titles[x.link_id] || x.title || null,
        amount: Number(x.pay_amount),
        net_amount: t ? Number(t.net_amount) : null,
        commission: t ? Number(t.commission) : null,
        status,
        utr: x.utr || null,
        created_at: x.created_at,
        paid_at: x.paid_at || null,
        source: 'checkout'
      };
    });

    // Session ke bina hui confirmed payments (purani / developer API)
    for (const t of txns) {
      if (t.utr && sessionUtrs.has(t.utr)) continue;
      rows.push({
        id: t.id,
        order_id: orderCodes[t.order_id] || null,
        link_id: null,
        link_title: null,
        amount: Number(t.amount),
        net_amount: Number(t.net_amount),
        commission: Number(t.commission),
        status: 'success',
        utr: t.utr || null,
        created_at: t.created_at,
        paid_at: t.created_at,
        source: 'manual'
      });
    }

    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const hasMore = rows.length > limit || sessions.length > limit || txns.length > limit;
    const page = rows.slice(0, limit);

    return res.json({
      success: true,
      data: {
        payments: page,
        has_more: hasMore,
        next_before: page.length ? page[page.length - 1].created_at : null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;