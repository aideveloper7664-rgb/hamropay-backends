const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const T = require('../services/themes');

// Safe text: tags/control chars hatao, trim, length limit. Frontend ise text ki tarah hi dikhata hai.
const cleanText = (v, max) => String(v).replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function settingsOf(m) {
  return {
    theme: T.isValidTheme(m.checkout_theme) ? m.checkout_theme : T.DEFAULTS.theme,
    color: m.checkout_color || null,
    brand_name: m.checkout_brand_name || null,
    logo_url: m.checkout_logo_url || null,
    footer: m.checkout_footer || null,
    shape: T.SHAPES[m.checkout_shape] ? m.checkout_shape : T.DEFAULTS.shape,
    font: T.FONTS[m.checkout_font] ? m.checkout_font : T.DEFAULTS.font
  };
}

// Public: saare themes (customize page ki gallery)
router.get('/themes', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({ success: true, data: T.catalog() });
});

// Merchant: abhi ki settings + pay page par kaisa dikhega
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data: m, error } = await supabase.from('merchants').select('*').eq('id', req.merchant.id).maybeSingle();
    if (error || !m) return res.status(404).json({ success: false, message: 'Merchant not found' });
    return res.json({ success: true, data: { settings: settingsOf(m), branding: T.resolveBranding(m) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Merchant: settings save (jo fields bheje wahi badalte hain)
router.put('/', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    const errors = [];

    if (b.theme !== undefined) {
      if (!T.isValidTheme(b.theme)) errors.push({ field: 'theme', msg: 'Unknown theme' });
      else patch.checkout_theme = b.theme;
    }
    if (b.color !== undefined) {
      if (b.color === null || b.color === '') patch.checkout_color = null;
      else if (typeof b.color === 'string' && T.HEX.test(b.color)) patch.checkout_color = b.color.toLowerCase();
      else errors.push({ field: 'color', msg: 'Color must be a hex code like #ff2d55' });
    }
    if (b.brand_name !== undefined) {
      if (b.brand_name === null) patch.checkout_brand_name = null;
      else if (typeof b.brand_name !== 'string') errors.push({ field: 'brand_name', msg: 'Brand name must be text' });
      else patch.checkout_brand_name = cleanText(b.brand_name, T.catalog().limits.brand_name) || null;
    }
    if (b.logo_url !== undefined) {
      if (b.logo_url === null || b.logo_url === '') patch.checkout_logo_url = null;
      else {
        let ok = false;
        try { const u = new URL(String(b.logo_url)); ok = u.protocol === 'https:' && String(b.logo_url).length <= 500; } catch { ok = false; }
        if (!ok) errors.push({ field: 'logo_url', msg: 'Logo must be a valid https:// image URL (max 500 characters)' });
        else patch.checkout_logo_url = String(b.logo_url);
      }
    }
    if (b.footer !== undefined) {
      if (b.footer === null) patch.checkout_footer = null;
      else if (typeof b.footer !== 'string') errors.push({ field: 'footer', msg: 'Footer must be text' });
      else patch.checkout_footer = cleanText(b.footer, T.catalog().limits.footer) || null;
    }
    if (b.shape !== undefined) {
      if (!T.SHAPES[b.shape]) errors.push({ field: 'shape', msg: 'Shape must be sharp, round or pill' });
      else patch.checkout_shape = b.shape;
    }
    if (b.font !== undefined) {
      if (!T.FONTS[b.font]) errors.push({ field: 'font', msg: 'Unknown font' });
      else patch.checkout_font = b.font;
    }

    if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
    if (Object.keys(patch).length === 0) return res.status(400).json({ success: false, message: 'Nothing to update' });

    const { data: m, error } = await supabase.from('merchants').update(patch).eq('id', req.merchant.id).select('*').maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ success: false, message: 'Merchant not found' });

    return res.json({ success: true, message: 'Checkout page updated', data: { settings: settingsOf(m), branding: T.resolveBranding(m) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Merchant: draft ka live preview. Kuch save nahi hota; wahi hisaab chalta hai jo asli pay page par chalega.
router.post('/preview', authMiddleware, (req, res) => {
  const b = req.body || {};
  const lim = T.catalog().limits;
  let logo = null;
  try { const u = new URL(String(b.logo_url || '')); if (u.protocol === 'https:' && String(b.logo_url).length <= lim.logo_url) logo = String(b.logo_url); } catch { /* invalid -> no logo */ }
  const draft = {
    name: req.merchant.name || '',
    checkout_theme: T.isValidTheme(b.theme) ? b.theme : undefined,
    checkout_color: typeof b.color === 'string' && T.HEX.test(b.color) ? b.color.toLowerCase() : null,
    checkout_brand_name: typeof b.brand_name === 'string' ? (cleanText(b.brand_name, lim.brand_name) || null) : null,
    checkout_logo_url: logo,
    checkout_footer: typeof b.footer === 'string' ? (cleanText(b.footer, lim.footer) || null) : null,
    checkout_shape: T.SHAPES[b.shape] ? b.shape : undefined,
    checkout_font: T.FONTS[b.font] ? b.font : undefined
  };
  return res.json({ success: true, data: { branding: T.resolveBranding(draft) } });
});

// Merchant: sab kuch default par wapas
router.post('/reset', authMiddleware, async (req, res) => {
  try {
    const { data: m, error } = await supabase.from('merchants').update({
      checkout_theme: T.DEFAULTS.theme, checkout_color: null, checkout_brand_name: null,
      checkout_logo_url: null, checkout_footer: null, checkout_shape: T.DEFAULTS.shape, checkout_font: T.DEFAULTS.font
    }).eq('id', req.merchant.id).select('*').maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ success: false, message: 'Merchant not found' });
    return res.json({ success: true, message: 'Checkout page reset to default', data: { settings: settingsOf(m), branding: T.resolveBranding(m) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
