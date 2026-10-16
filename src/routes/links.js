const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Create Payment Link
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { title, amount, note, is_test } = req.body;

    if (!title || !amount) {
      return res.status(400).json({ success: false, message: 'Title and amount required' });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
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
        message: 'Please connect FamPay or Paytm account first to create payment links'
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
        is_test: is_test === true,
        total_collected: 0,
        total_orders: 0
      }])
      .select()
      .single();

    if (error) throw error;

    const paymentUrl = `${process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app'}/pay/${linkId}`;

    return res.status(201).json({
      success: true,
      data: {
        ...data,
        payment_url: paymentUrl,
        upi_id: cashier.upi_id,
        cashier_type: cashier.type,
        qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=upi://pay?pa=${cashier.upi_id}&pn=Payment&am=${amount}&cu=INR`
      }
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
      payment_url: `${process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app'}/pay/${link.link_id}`
    }));

    return res.json({ success: true, data: links });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get single link (public)
router.get('/:linkId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_links')
      .select('*, merchants(name, id)')
      .eq('link_id', req.params.linkId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'Payment link not found' });
    }

    // Merchant disabled this link -> customer must not be able to pay
    if (data.status !== 'active') {
      return res.status(403).json({
        success: false,
        code: 'LINK_DISABLED',
        message: 'This payment link is currently disabled by the merchant'
      });
    }

    // Get merchant active cashier
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('upi_id, type')
      .eq('merchant_id', data.merchants.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!cashier) {
      return res.status(409).json({ success: false, message: 'Merchant has no active payment account' });
    }

    // Only safe, public fields (never spread the DB row: it can contain merchant data)
    return res.json({
      success: true,
      data: {
        link_id: data.link_id,
        title: data.title,
        amount: data.amount,
        note: data.note,
        status: data.status,
        is_test: !!data.is_test,
        merchant_name: data.merchants?.name || '',
        upi_id: cashier.upi_id,
        cashier_type: cashier.type,
        qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=${encodeURIComponent(`upi://pay?pa=${cashier.upi_id}&pn=Payment&am=${data.amount}&cu=INR`)}`
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Update link: enable/disable, test mode, edit details (merchant only)
router.patch('/:linkId', authMiddleware, async (req, res) => {
  try {
    const { status, is_test, title, amount, note } = req.body;
    const updates = {};

    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ success: false, message: "status must be 'active' or 'inactive'" });
      }
      updates.status = status;
    }
    if (is_test !== undefined) {
      if (typeof is_test !== 'boolean') {
        return res.status(400).json({ success: false, message: 'is_test must be true or false' });
      }
      updates.is_test = is_test;
    }
    if (title !== undefined) {
      if (!String(title).trim()) {
        return res.status(400).json({ success: false, message: 'Title cannot be empty' });
      }
      updates.title = String(title).trim();
    }
    if (amount !== undefined) {
      if (!(Number(amount) > 0)) {
        return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
      }
      updates.amount = Number(amount);
    }
    if (note !== undefined) updates.note = note;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('payment_links')
      .update(updates)
      .eq('link_id', req.params.linkId)
      .eq('merchant_id', req.merchant.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: 'Payment link not found' });
    }

    return res.json({
      success: true,
      data: {
        ...data,
        payment_url: `${process.env.FRONTEND_URL || 'https://hamro-pay-kilj.vercel.app'}/pay/${data.link_id}`
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Delete link
router.delete('/:linkId', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('payment_links')
      .delete()
      .eq('link_id', req.params.linkId)
      .eq('merchant_id', req.merchant.id);

    if (error) throw error;
    return res.json({ success: true, message: 'Link deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Verify payment for link
router.post('/:linkId/verify', async (req, res) => {
  try {
    const { utr } = req.body;

    if (!utr) {
      return res.status(400).json({ success: false, message: 'UTR required' });
    }

    const { data: link, error: linkError } = await supabase
      .from('payment_links')
      .select('*, merchants(*)')
      .eq('link_id', req.params.linkId)
      .single();

    if (linkError || !link) {
      return res.status(404).json({ success: false, message: 'Payment link not found' });
    }

    if (link.status !== 'active') {
      return res.status(403).json({
        success: false,
        code: 'LINK_DISABLED',
        message: 'This payment link is currently disabled by the merchant'
      });
    }

    // ---------- TEST MODE: no Gmail check, no wallet, no credits, no DB writes ----------
    if (link.is_test) {
      const TEST_UTR = '000000000000';
      if (String(utr).trim() !== TEST_UTR) {
        return res.status(400).json({
          success: false,
          test_mode: true,
          message: `Test mode: enter UTR ${TEST_UTR} to simulate a successful payment`
        });
      }

      const testOrderId = 'TEST_' + uuidv4().replace(/-/g, '').toUpperCase().slice(0, 12);

      if (link.merchants?.webhook_url) {
        fetch(link.merchants.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'payment.test',
            test: true,
            order_id: testOrderId,
            link_id: req.params.linkId,
            utr: TEST_UTR,
            amount: link.amount
          })
        }).catch(() => {});
      }

      return res.json({
        success: true,
        test_mode: true,
        message: 'Test payment successful (no real money moved)',
        data: { order_id: testOrderId, utr: TEST_UTR, amount: link.amount, net_amount: link.amount, commission: 0, test: true }
      });
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

    // Get merchant cashier
    const { data: cashier } = await supabase
      .from('cashier_accounts')
      .select('*')
      .eq('merchant_id', link.merchants.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Verify UTR
    let verified = null;
    const payAmount = link.amount; // never trust amount from the client

    if (cashier && cashier.type === 'fampay' && cashier.gmail_app_password) {
      const crypto = require('crypto');
      const key = process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32);
      const [ivHex, encrypted] = cashier.gmail_app_password.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const gmailService = require('../services/gmail.service');
      verified = await gmailService.verifyUTRWithCredentials(
        utr, payAmount, cashier.gmail_email, decrypted
      );
    } else {
      const gmailService = require('../services/gmail.service');
      verified = await gmailService.verifyUTR(utr, payAmount);
    }

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Payment not found. Check UTR and try again.' });
    }

    const merchant = link.merchants;
    const commissionPercent = merchant.commission || 2;
    const commission = (payAmount * commissionPercent) / 100;
    const netAmount = payAmount - commission;

    // Check Hamro Credit
    const { data: credit } = await supabase
      .from('hamro_credits')
      .select('balance, total_spent')
      .eq('merchant_id', merchant.id)
      .single();

    if (!credit || credit.balance < commission) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient Hamro Credits. Please purchase more credits.'
      });
    }

    // Create order record
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

    // Save transaction
    await supabase.from('transactions').insert([{
      order_id: order.id,
      merchant_id: merchant.id,
      amount: payAmount,
      commission,
      net_amount: netAmount,
      utr,
      gmail_message_id: verified.messageId
    }]);

    // Credit Hamro Cash (wallet)
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

    // Deduct Hamro Credit
    await supabase.from('hamro_credits').update({
      balance: credit.balance - commission,
      total_spent: (credit.total_spent || 0) + commission,
      updated_at: new Date().toISOString()
    }).eq('merchant_id', merchant.id);

    // Save credit transaction
    await supabase.from('credit_transactions').insert([{
      merchant_id: merchant.id,
      type: 'deduct',
      amount: commission,
      order_id: orderId,
      note: `Commission for link ${req.params.linkId}`
    }]);

    // Update link stats
    await supabase.from('payment_links').update({
      total_collected: (link.total_collected || 0) + payAmount,
      total_orders: (link.total_orders || 0) + 1
    }).eq('link_id', req.params.linkId);

    // Fire webhook
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
          net_amount: netAmount,
          commission
        })
      }).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Payment verified!',
      data: { order_id: orderId, utr, amount: payAmount, net_amount: netAmount, commission }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;