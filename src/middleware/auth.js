const jwt = require('jsonwebtoken');
require('dotenv').config();

const authMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ success: false, message: 'API key required' });
  }

  const supabase = require('../config/supabase');
  
  supabase
    .from('merchants')
    .select('*')
    .eq('api_key', apiKey)
    .eq('is_active', true)
    .single()
    .then(({ data, error }) => {
      if (error || !data) {
        return res.status(401).json({ success: false, message: 'Invalid API key' });
      }
      req.merchant = data;
      next();
    });
};

const adminMiddleware = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

module.exports = { authMiddleware, adminMiddleware };