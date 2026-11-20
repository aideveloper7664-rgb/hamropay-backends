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

const adminMiddleware = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
  if (decoded.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }

  // Database admin (aid): har request par check, taaki disable karte hi access band ho jaye
  if (decoded.aid) {
    try {
      const supabase = require('../config/supabase');
      const { data: admin } = await supabase
        .from('admins').select('id, email, is_active').eq('id', decoded.aid).maybeSingle();
      if (!admin || !admin.is_active) {
        return res.status(401).json({ success: false, message: 'Admin account is disabled' });
      }
      req.admin = { ...decoded, email: admin.email };
    } catch {
      return res.status(500).json({ success: false, message: 'Could not verify admin' });
    }
    return next();
  }

  req.admin = decoded;   // purana env admin token
  return next();
};

// Sirf database admin (aid wala token); env admin ko full-data API nahi milti
const dbAdminMiddleware = (req, res, next) =>
  adminMiddleware(req, res, () => {
    if (!req.admin || !req.admin.aid) {
      return res.status(403).json({ success: false, message: 'Database admin account required' });
    }
    return next();
  });

module.exports = { authMiddleware, adminMiddleware, dbAdminMiddleware };