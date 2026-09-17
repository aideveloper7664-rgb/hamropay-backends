const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Create Order
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { amount, customer_name, customer_email } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    const orderId = 'ORD_' + uuidv4().replace(/-/g, '').toUpperCase().slice(0, 16);

    const { data: order, error } = await supabase
      .from('orders')
      .insert([{
        merchant_id: req.merchant.id,
        order_id: orderId,
        amount,
        customer_name,
        customer_email,
        status: 'pending',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    // Get FamPay UPI from settings
    const { data: settings } = await supabase
      .from('settings')
      .select('fampay_upi, fampay_qr')
      .single();

    return res.status(201).json({
      success: true,
      message: 'Order created',
      data: {
        order_id: orderId,
        amount,
        upi_id: settings?.fampay_upi || '',
        qr_code: settings?.fampay_qr || '',
        expires_at: order.expires_at,
        payment_url: `${process.env.PAYMENT_URL || ''}/pay/${orderId}`
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Verify UTR
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const { order_id, utr } = req.body;

    if (!order_id || !utr) {
      return res.status(400).json({ success: false, message: 'order_id and utr required' });
    }

    // Check order exists
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', order_id)
      .eq('merchant_id', req.merchant.id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status === 'success') {
      return res.status(400).json({ success: false, message: 'Order already paid' });
    }

    if (new Date() > new Date(order.expires_at)) {
      await supabase.from('orders').update({ status: 'expired' }).eq('order_id', order_id);
      return res.status(400).json({ success: false, message: 'Order expired' });
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
    const verified = await gmailService.verifyUTR(utr, order.amount);

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Payment not found. Check UTR and try again.' });
    }

    // Calculate commission
    const commission = (order.amount * req.merchant.commission) / 100;
    const netAmount = order.amount - commission;

    // Save transaction
    const { error: txnError } = await supabase
      .from('transactions')
      .insert([{
        order_id: order.id,
        merchant_id: req.merchant.id,
        amount: order.amount,
        commission,
        net_amount: netAmount,
        utr,
        gmail_message_id: verified.messageId
      }]);

    if (txnError) throw txnError;

    // Update order status
    await supabase
      .from('orders')
      .update({ status: 'success', utr })
      .eq('order_id', order_id);

    // Credit merchant wallet
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance, total_earned')
      .eq('merchant_id', req.merchant.id)
      .single();

    await supabase
      .from('wallets')
      .update({
        balance: (wallet.balance || 0) + netAmount,
        total_earned: (wallet.total_earned || 0) + netAmount,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    // Fire webhook
    if (req.merchant.webhook_url) {
      fetch(req.merchant.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment.success',
          order_id,
          utr,
          amount: order.amount,
          net_amount: netAmount
        })
      }).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Payment verified successfully',
      data: {
        order_id,
        utr,
        amount: order.amount,
        net_amount: netAmount,
        commission
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Check Order Status
router.get('/status/:order_id', authMiddleware, async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', req.params.order_id)
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    return res.json({ success: true, data: order });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;