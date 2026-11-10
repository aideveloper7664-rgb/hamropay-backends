// Checkout (pay page) themes + branding. Frontend me koi rang pakka nahi: sab kuch yahin se aata hai,
// isliye naya theme jodna = neeche THEMES me ek entry.

const DARK_SEMANTIC = { ok: '#34d399', warn: '#fbbf24', bad: '#fb7185' };
const LIGHT_SEMANTIC = { ok: '#059669', warn: '#b45309', bad: '#e11d48' };

// base = page ka mukhya rang (contrast check aur preview ke liye). bg = asli CSS background (gradient ho sakta hai).
const THEMES = [
  // ---------- DARK ----------
  { id: 'default', name: 'Hamro Crimson', group: 'Dark', mode: 'dark', base: '#0b0508',
    bg: 'radial-gradient(ellipse at top, #2a0a14 0%, #0b0508 62%)', surface: '#150a0e', surface2: '#1e0f15', border: '#3a1522',
    text: '#fff4f6', muted: '#c9a3ae', accent: '#ff2d55', accent2: '#be123c', onAccent: '#ffffff' },
  { id: 'midnight', name: 'Midnight Blue', group: 'Dark', mode: 'dark', base: '#070b16',
    bg: 'radial-gradient(ellipse at top, #0f2552 0%, #070b16 65%)', surface: '#0e1526', surface2: '#141d33', border: '#233256',
    text: '#eef3ff', muted: '#9db0d6', accent: '#3b82f6', accent2: '#1d4ed8', onAccent: '#ffffff' },
  { id: 'emerald', name: 'Emerald Night', group: 'Dark', mode: 'dark', base: '#06100c',
    bg: 'radial-gradient(ellipse at top, #0d3324 0%, #06100c 65%)', surface: '#0c1a14', surface2: '#12261d', border: '#1f4033',
    text: '#ecfdf5', muted: '#8fc7ae', accent: '#10b981', accent2: '#047857', onAccent: '#04130d' },
  { id: 'ember', name: 'Ember', group: 'Dark', mode: 'dark', base: '#110804',
    bg: 'radial-gradient(ellipse at top, #3a1a08 0%, #110804 65%)', surface: '#1b0f08', surface2: '#26160c', border: '#47260f',
    text: '#fff7ed', muted: '#d6a57d', accent: '#f97316', accent2: '#c2410c', onAccent: '#1a0a02' },
  { id: 'obsidian', name: 'Obsidian', group: 'Dark', mode: 'dark', base: '#050505',
    bg: '#050505', surface: '#0f0f10', surface2: '#18181a', border: '#2a2a2e',
    text: '#fafafa', muted: '#a1a1aa', accent: '#f4f4f5', accent2: '#a1a1aa', onAccent: '#0a0a0a' },
  { id: 'royal', name: 'Royal Gold', group: 'Dark', mode: 'dark', base: '#070a14',
    bg: 'radial-gradient(ellipse at top, #1b2150 0%, #070a14 65%)', surface: '#0d1226', surface2: '#141b38', border: '#2e3763',
    text: '#fff8e7', muted: '#c4b98a', accent: '#fbbf24', accent2: '#d97706', onAccent: '#1a1203' },
  { id: 'slate', name: 'Slate', group: 'Dark', mode: 'dark', base: '#0b0f14',
    bg: '#0b0f14', surface: '#121820', surface2: '#1a222d', border: '#2b3646',
    text: '#e8edf4', muted: '#93a1b5', accent: '#38bdf8', accent2: '#0284c7', onAccent: '#04141e' },
  { id: 'forest', name: 'Forest', group: 'Dark', mode: 'dark', base: '#080d08',
    bg: 'radial-gradient(ellipse at top, #16301a 0%, #080d08 65%)', surface: '#0f170f', surface2: '#162116', border: '#2a3f2a',
    text: '#f1f8ec', muted: '#9dbb92', accent: '#84cc16', accent2: '#4d7c0f', onAccent: '#0d1503' },
  { id: 'plum', name: 'Plum', group: 'Dark', mode: 'dark', base: '#0d0612',
    bg: 'radial-gradient(ellipse at top, #34104a 0%, #0d0612 65%)', surface: '#160c1d', surface2: '#201229', border: '#3d2252',
    text: '#fbf2ff', muted: '#c3a3d6', accent: '#c026d3', accent2: '#86198f', onAccent: '#ffffff' },

  // ---------- GRADIENT / NEON ----------
  { id: 'aurora', name: 'Aurora', group: 'Gradient', mode: 'dark', base: '#0a0f2a',
    bg: 'linear-gradient(160deg, #0a0620 0%, #0b2a3a 55%, #0b3b2e 100%)', surface: '#0d1630', surface2: '#13203f', border: '#27407a',
    text: '#effbff', muted: '#9cc4d8', accent: '#2dd4bf', accent2: '#7c3aed', onAccent: '#041416' },
  { id: 'sunset', name: 'Sunset', group: 'Gradient', mode: 'dark', base: '#1a0716',
    bg: 'linear-gradient(160deg, #1a0716 0%, #3a0d2a 50%, #4a1a0a 100%)', surface: '#240d1d', surface2: '#301427', border: '#5a2740',
    text: '#fff1ee', muted: '#e0a8a0', accent: '#fb7185', accent2: '#f97316', onAccent: '#1c0508' },
  { id: 'ocean', name: 'Ocean Deep', group: 'Gradient', mode: 'dark', base: '#03111f',
    bg: 'linear-gradient(160deg, #03111f 0%, #062b4a 100%)', surface: '#07203a', surface2: '#0c2d4d', border: '#1b4a73',
    text: '#eaf6ff', muted: '#93bcd9', accent: '#22d3ee', accent2: '#0ea5e9', onAccent: '#021520' },
  { id: 'neon', name: 'Neon', group: 'Gradient', mode: 'dark', base: '#02030a',
    bg: '#02030a', surface: '#080b14', surface2: '#0e1320', border: '#183a3a',
    text: '#e8fffb', muted: '#7fd6c8', accent: '#00ffd5', accent2: '#00b3ff', onAccent: '#00110e' },
  { id: 'cyber', name: 'Cyberpunk', group: 'Gradient', mode: 'dark', base: '#0d0221',
    bg: 'linear-gradient(160deg, #0d0221 0%, #1a0536 100%)', surface: '#150433', surface2: '#1e0a47', border: '#43207a',
    text: '#fdf4ff', muted: '#c9a8f0', accent: '#ff2bd6', accent2: '#ffe600', onAccent: '#14001a' },

  // ---------- LIGHT ----------
  { id: 'daylight', name: 'Daylight', group: 'Light', mode: 'light', base: '#f4f6fb',
    bg: '#f4f6fb', surface: '#ffffff', surface2: '#f0f3fa', border: '#dfe5f1',
    text: '#0f172a', muted: '#5b6a85', accent: '#2563eb', accent2: '#1d4ed8', onAccent: '#ffffff' },
  { id: 'paper', name: 'Paper', group: 'Light', mode: 'light', base: '#f7f2e9',
    bg: '#f7f2e9', surface: '#fffdf8', surface2: '#f2eadb', border: '#e3d7c0',
    text: '#2b2418', muted: '#6f6450', accent: '#b45309', accent2: '#92400e', onAccent: '#ffffff' },
  { id: 'rose', name: 'Rose', group: 'Light', mode: 'light', base: '#fff1f4',
    bg: '#fff1f4', surface: '#ffffff', surface2: '#ffe6ec', border: '#fbc9d6',
    text: '#3a0a18', muted: '#8a4a5c', accent: '#e11d48', accent2: '#be123c', onAccent: '#ffffff' },
  { id: 'mint', name: 'Mint', group: 'Light', mode: 'light', base: '#ecfdf5',
    bg: '#ecfdf5', surface: '#ffffff', surface2: '#dcfce7', border: '#b6efd0',
    text: '#052e1a', muted: '#3f6b55', accent: '#059669', accent2: '#047857', onAccent: '#ffffff' },
  { id: 'lavender', name: 'Lavender', group: 'Light', mode: 'light', base: '#f5f3ff',
    bg: '#f5f3ff', surface: '#ffffff', surface2: '#ede9fe', border: '#d6ccfa',
    text: '#1e1146', muted: '#5f4f94', accent: '#7c3aed', accent2: '#5b21b6', onAccent: '#ffffff' },
  { id: 'sky', name: 'Sky', group: 'Light', mode: 'light', base: '#f0f9ff',
    bg: '#f0f9ff', surface: '#ffffff', surface2: '#e0f2fe', border: '#bae0f7',
    text: '#082f49', muted: '#476a85', accent: '#0284c7', accent2: '#075985', onAccent: '#ffffff' }
];

const SHAPES = {
  sharp: { id: 'sharp', name: 'Sharp', card: '6px', inner: '4px', button: '6px' },
  round: { id: 'round', name: 'Rounded', card: '20px', inner: '12px', button: '12px' },
  pill:  { id: 'pill',  name: 'Pill',  card: '30px', inner: '18px', button: '999px' }
};

const FONTS = {
  modern:  { id: 'modern',  name: 'Modern',  stack: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  classic: { id: 'classic', name: 'Classic', stack: "Georgia, 'Times New Roman', serif" },
  mono:    { id: 'mono',    name: 'Mono',    stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
  rounded: { id: 'rounded', name: 'Rounded', stack: "ui-rounded, 'Nunito', 'Varela Round', system-ui, sans-serif" }
};

const DEFAULTS = { theme: 'default', color: null, brand_name: null, logo_url: null, footer: null, shape: 'round', font: 'modern' };
const HEX = /^#[0-9a-fA-F]{6}$/;

// ---------- color helpers ----------
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = toRgb(a), y = toRgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const rgba = (hex, a) => { const [r, g, b] = toRgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };
function luminance(hex) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const [r, g, b] = toRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));
const isValidTheme = (id) => Object.prototype.hasOwnProperty.call(THEME_BY_ID, id);

// Merchant row (kuch columns na ho to bhi chalega) -> pay page ke liye taiyaar branding.
// `vars` ko seedha style={{...vars}} me laga do. Isme koi secret nahi hota.
function resolveBranding(m) {
  m = m || {};
  const theme = THEME_BY_ID[m.checkout_theme] || THEME_BY_ID[DEFAULTS.theme];
  const shape = SHAPES[m.checkout_shape] || SHAPES[DEFAULTS.shape];
  const font = FONTS[m.checkout_font] || FONTS[DEFAULTS.font];

  let accent = theme.accent, accent2 = theme.accent2, onAccent = theme.onAccent;
  const custom = m.checkout_color && HEX.test(m.checkout_color) ? m.checkout_color.toLowerCase() : null;
  if (custom) {
    accent = custom;
    accent2 = mix(custom, '#000000', 0.28);
    onAccent = contrast(custom, '#ffffff') >= contrast(custom, '#0a0a0a') ? '#ffffff' : '#0a0a0a';
  }
  const sem = theme.mode === 'light' ? LIGHT_SEMANTIC : DARK_SEMANTIC;

  return {
    theme_id: theme.id,
    theme_name: theme.name,
    mode: theme.mode,
    custom_color: custom,
    brand_name: m.checkout_brand_name || m.name || '',
    logo_url: m.checkout_logo_url || null,
    footer: m.checkout_footer || null,
    shape: shape.id,
    font: font.id,
    powered_by: 'Hamro Pay',
    vars: {
      '--hp-bg': theme.bg,
      '--hp-bg-base': theme.base,
      '--hp-surface': theme.surface,
      '--hp-surface-2': theme.surface2,
      '--hp-border': theme.border,
      '--hp-text': theme.text,
      '--hp-muted': theme.muted,
      '--hp-accent': accent,
      '--hp-accent-2': accent2,
      '--hp-on-accent': onAccent,
      '--hp-grad': `linear-gradient(135deg, ${accent}, ${accent2})`,
      '--hp-glow': rgba(accent, 0.35),
      '--hp-accent-soft': rgba(accent, 0.14),
      '--hp-ok': sem.ok,
      '--hp-warn': sem.warn,
      '--hp-bad': sem.bad,
      '--hp-radius': shape.card,
      '--hp-radius-sm': shape.inner,
      '--hp-radius-btn': shape.button,
      '--hp-font': font.stack
    }
  };
}

// Catalog (customize page ki gallery): har theme ka preview rang + group
function catalog() {
  return {
    themes: THEMES.map((t) => ({
      id: t.id, name: t.name, group: t.group, mode: t.mode,
      preview: { bg: t.bg, base: t.base, surface: t.surface, text: t.text, accent: t.accent, accent2: t.accent2, on_accent: t.onAccent }
    })),
    shapes: Object.values(SHAPES).map(({ id, name }) => ({ id, name })),
    fonts: Object.values(FONTS).map(({ id, name, stack }) => ({ id, name, stack })),
    accent_presets: ['#ff2d55', '#f97316', '#fbbf24', '#84cc16', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#ef4444', '#64748b'],
    limits: { brand_name: 40, logo_url: 500, footer: 120 },
    defaults: DEFAULTS
  };
}

module.exports = { THEMES, SHAPES, FONTS, DEFAULTS, HEX, isValidTheme, resolveBranding, catalog, contrast, luminance, mix };
