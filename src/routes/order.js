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

    // Check if merchant has active cashier
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('id, upi_id, type')
      .eq('merchant_id', req.merchant.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!cashier) {
      return res.status(400).json({
        success: false,
        message: 'Please connect FamPay or Paytm account first'
      });
    }

    // Check Hamro Credit balance
    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (!credit || credit.balance <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient Hamro Credits. Please purchase more credits.'
      });
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

    // Get settings for fallback
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
        upi_id: cashier.upi_id,
        cashier_type: cashier.type,
        qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=upi://pay?pa=${cashier.upi_id}&pn=Payment&am=${amount}&cu=INR`,
        expires_at: order.expires_at,
        payment_url: `${process.env.FRONTEND_URL || ''}/pay/${orderId}`
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

    // Check merchant cashier
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('*')
      .eq('merchant_id', req.merchant.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Verify UTR
    let verified = null;

    if (cashier && cashier.type === 'fampay' && cashier.gmail_app_password) {
      // Decrypt app password
      const crypto = require('crypto');
      const key = process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32);
      const [ivHex, encrypted] = cashier.gmail_app_password.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const gmailService = require('../services/gmail.service');
      verified = await gmailService.verifyUTRWithCredentials(
        utr, order.amount, cashier.gmail_email, decrypted
      );
    } else {
      // Fallback to admin Gmail
      const gmailService = require('../services/gmail.service');
      verified = await gmailService.verifyUTR(utr, order.amount);
    }

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Payment not found. Check UTR and try again.' });
    }

    // Check Hamro Credit balance
    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance, total_spent')
      .eq('merchant_id', req.merchant.id)
      .single();

    // Calculate commission
    const commissionPercent = req.merchant.commission || 2;
    const commission = (order.amount * commissionPercent) / 100;
    const netAmount = order.amount - commission;

    // Check sufficient credits
    if (!credit || credit.balance < commission) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient Hamro Credits to process payment. Please purchase more credits.'
      });
    }

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

    // Credit merchant wallet (Hamro Cash)
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

    // Deduct Hamro Credit (commission)
    await supabase
      .from('hamro_credits')
      .update({
        balance: credit.balance - commission,
        total_spent: (credit.total_spent || 0) + commission,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    // Save credit transaction
    await supabase.from('credit_transactions').insert([{
      merchant_id: req.merchant.id,
      type: 'deduct',
      amount: commission,
      order_id: order_id,
      note: `Commission deducted for order ${order_id}`
    }]);

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
          net_amount: netAmount,
          commission
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
router.get('/status/:order_id', async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('*, merchants(name)')
      .eq('order_id', req.params.order_id)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Get merchant cashier
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('upi_id, type')
      .eq('merchant_id', order.merchant_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!cashier) {
      return res.status(409).json({ success: false, message: 'Merchant has no active payment account' });
    }

    return res.json({
      success: true,
      data: {
        order_id: order.order_id,
        amount: order.amount,
        status: order.status,
        expires_at: order.expires_at,
        merchant_name: order.merchants?.name || '',
        upi_id: cashier.upi_id,
        cashier_type: cashier.type,
        qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=${encodeURIComponent(`upi://pay?pa=${cashier.upi_id}&pn=Payment&am=${order.amount}&cu=INR`)}`
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;