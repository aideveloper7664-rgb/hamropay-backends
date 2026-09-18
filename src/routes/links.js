const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Create Payment Link
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { title, amount, note } = req.body;

    if (!title || !amount) {
      return res.status(400).json({ success: false, message: 'Title and amount required' });
    }

    const linkId = 'lnk_' + uuidv4().replace(/-/g, '').slice(0, 16);

    const { data, error } = await supabase
      .from('payment_links')
      .insert([{
        merchant_id: req.merchant.id,
        link_id: linkId,
        title,
        amount,
        note,
        status: 'active',
        total_collected: 0,
        total_orders: 0
      }])
      .select()
      .single();

    if (error) throw error;

    const paymentUrl = `${process.env.FRONTEND_URL || 'https://hamropay-backends.onrender.com'}/pay/${linkId}`;

    return res.status(201).json({
      success: true,
      data: { ...data, payment_url: paymentUrl }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get all links
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_links')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const links = data.map(link => ({
      ...link,
      payment_url: `${process.env.FRONTEND_URL || 'https://hamropay-backends.onrender.com'}/pay/${link.link_id}`
    }));

    return res.json({ success: true, data: links });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get single link (public - customer facing)
router.get('/:linkId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_links')
      .select('*, merchants(name)')
      .eq('link_id', req.params.linkId)
      .eq('status', 'active')
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'Payment link not found' });
    }

    const { data: settings } = await supabase
      .from('settings')
      .select('fampay_upi, fampay_qr')
      .single();

    return res.json({
      success: true,
      data: {
        ...data,
        upi_id: settings?.fampay_upi || '',
        qr_code: settings?.fampay_qr || ''
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Delete/Deactivate link
router.delete('/:linkId', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('payment_links')
      .update({ status: 'inactive' })
      .eq('link_id', req.params.linkId)
      .eq('merchant_id', req.merchant.id);

    if (error) throw error;
    return res.json({ success: true, message: 'Link deactivated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Verify payment for link (customer submits UTR)
router.post('/:linkId/verify', async (req, res) => {
  try {
    const { utr, amount } = req.body;

    if (!utr) {
      return res.status(400).json({ success: false, message: 'UTR required' });
    }

    const { data: link, error: linkError } = await supabase
      .from('payment_links')
      .select('*, merchants(*)')
      .eq('link_id', req.params.linkId)
      .eq('status', 'active')
      .single();

    if (linkError || !link) {
      return res.status(404).json({ success: false, message: 'Link not found or inactive' });
    }

    // Check UTR already used
    const { data: existingTxn } = await supabase
      .from('transactions')
      .select('id')
      .eq('utr', utr)
      .single();

    if (existingTxn) {
      return res.status(400).json({ success: false, message: 'UTR already used' });
    }

    // Verify UTR in Gmail
    const gmailService = require('../services/gmail.service');
    const payAmount = amount || link.amount;
    const verified = await gmailService.verifyUTR(utr, payAmount);

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Payment not found. Check UTR and try again.' });
    }

    const merchant = link.merchants;
    const commission = (payAmount * merchant.commission) / 100;
    const netAmount = payAmount - commission;

    const orderId = 'ORD_' + uuidv4().replace(/-/g, '').toUpperCase().slice(0, 16);

    const { data: order } = await supabase
      .from('orders')
      .insert([{
        merchant_id: merchant.id,
        order_id: orderId,
        amount: payAmount,
        status: 'success',
        utr,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      }])
      .select()
      .single();

    await supabase.from('transactions').insert([{
      order_id: order.id,
      merchant_id: merchant.id,
      amount: payAmount,
      commission,
      net_amount: netAmount,
      utr,
      gmail_message_id: verified.messageId
    }]);

    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance, total_earned')
      .eq('merchant_id', merchant.id)
      .single();

    await supabase.from('wallets').update({
      balance: (wallet.balance || 0) + netAmount,
      total_earned: (wallet.total_earned || 0) + netAmount,
      updated_at: new Date().toISOString()
    }).eq('merchant_id', merchant.id);

    await supabase.from('payment_links').update({
      total_collected: (link.total_collected || 0) + payAmount,
      total_orders: (link.total_orders || 0) + 1
    }).eq('link_id', req.params.linkId);

    if (merchant.webhook_url) {
      fetch(merchant.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment.success',
          order_id: orderId,
          link_id: req.params.linkId,
          utr,
          amount: payAmount,
          net_amount: netAmount
        })
      }).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Payment verified!',
      data: { order_id: orderId, utr, amount: payAmount, net_amount: netAmount }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;