const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Get API token info
router.get('/token', authMiddleware, async (req, res) => {
  try {
    return res.json({
      success: true,
      data: {
        api_key: req.merchant.api_key,
        created_at: req.merchant.created_at,
        mode: req.merchant.mode || 'live'
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Regenerate API key
router.post('/token/regenerate', authMiddleware, async (req, res) => {
  try {
    const newKey = 'hmpay_' + uuidv4().replace(/-/g, '');

    const { error } = await supabase
      .from('merchants')
      .update({ api_key: newKey })
      .eq('id', req.merchant.id);

    if (error) throw error;

    return res.json({
      success: true,
      data: { api_key: newKey }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Set mode (live/test)
router.post('/mode', authMiddleware, async (req, res) => {
  try {
    const { mode } = req.body;

    if (!['live', 'test'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Mode must be live or test' });
    }

    await supabase
      .from('merchants')
      .update({ mode })
      .eq('id', req.merchant.id);

    return res.json({ success: true, message: `Mode set to ${mode}` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get webhooks
router.get('/webhooks', authMiddleware, async (req, res) => {
  try {
    return res.json({
      success: true,
      data: req.merchant.webhook_url
        ? [{ url: req.merchant.webhook_url, events: ['payment.success', 'payment.failed'] }]
        : []
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Add/Update webhook
router.post('/webhooks', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, message: 'Webhook URL required' });
    }

    await supabase
      .from('merchants')
      .update({ webhook_url: url })
      .eq('id', req.merchant.id);

    return res.json({ success: true, message: 'Webhook updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Delete webhook
router.delete('/webhooks', authMiddleware, async (req, res) => {
  try {
    await supabase
      .from('merchants')
      .update({ webhook_url: null })
      .eq('id', req.merchant.id);

    return res.json({ success: true, message: 'Webhook removed' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get API orders
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
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

module.exports = router;