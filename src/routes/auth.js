const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
require('dotenv').config();

// Merchant Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, webhook_url } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const apiKey = 'hmpay_' + uuidv4().replace(/-/g, '');

    const { data: merchant, error } = await supabase
      .from('merchants')
      .insert([{ name, email, password: hashedPassword, api_key: apiKey, webhook_url }])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ success: false, message: 'Email already exists' });
      }
      throw error;
    }

    // Create wallet for merchant
    await supabase.from('wallets').insert([{ merchant_id: merchant.id }]);

    return res.status(201).json({
      success: true,
      message: 'Merchant registered successfully',
      data: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        api_key: apiKey
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Merchant Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const { data: merchant, error } = await supabase
      .from('merchants')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !merchant) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, merchant.password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: merchant.id, email: merchant.email, role: 'merchant' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          api_key: merchant.api_key
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Login
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
    }

    const token = jwt.sign(
      { email, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Admin login successful',
      data: { token }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;