// HamroPay subscription plans: ek hi jagah (source of truth) jahan har plan ki limits likhi hain.
// Har enforcement point (links, API orders, webhooks, accounts, commission, branding) isi file se limit leta hai.
// null = unlimited.
const supabase = require('../config/supabase');

const DAY = 24 * 60 * 60 * 1000;
const DURATION_DAYS = 30;

const PLANS = {
  FREE: {
    store_products: 5, name: 'FREE', price: 0, rank: 0,
    links_per_month: 50, link_expiry_days: 3, max_amount: 150, commission: 5,
    webhooks: 0, api_orders: false, api_docs: false, advanced_api: false,
    accounts: { fampay: 1, paytm_mid: 1, amazon: 1 },
    custom_pages: false, qr_theme: false, branding: false, multiple_pages: false
  },
  BASIC: {
    store_products: 25, name: 'BASIC', price: 49, rank: 1,
    links_per_month: 250, link_expiry_days: 10, max_amount: 200, commission: 3.5,
    webhooks: 5, api_orders: true, api_docs: true, advanced_api: false,
    accounts: { fampay: 1, paytm_mid: 1, amazon: 1 },
    custom_pages: false, qr_theme: false, branding: false, multiple_pages: false
  },
  STARTER: {
    store_products: 100, name: 'STARTER', price: 99, rank: 2,
    links_per_month: 1000, link_expiry_days: 30, max_amount: 500, commission: 3,
    webhooks: 10, api_orders: true, api_docs: true, advanced_api: false,
    accounts: { fampay: 1, paytm_mid: 1, amazon: 1 },
    custom_pages: false, qr_theme: false, branding: false, multiple_pages: false
  },
  GROWTH: {
    store_products: 300, name: 'GROWTH', price: 199, rank: 3,
    links_per_month: 3000, link_expiry_days: 45, max_amount: 1000, commission: 2.5,
    webhooks: 25, api_orders: true, api_docs: true, advanced_api: false,
    accounts: { fampay: 2, paytm_mid: 2, amazon: 2 },
    custom_pages: false, qr_theme: false, branding: false, multiple_pages: false
  },
  BUSINESS: {
    store_products: 1000, name: 'BUSINESS', price: 499, rank: 4,
    links_per_month: 10000, link_expiry_days: 90, max_amount: 5000, commission: 2,
    webhooks: 50, api_orders: true, api_docs: true, advanced_api: false,
    accounts: { fampay: 2, paytm_mid: 2, amazon: 2 },
    custom_pages: true, qr_theme: true, branding: false, multiple_pages: false
  },
  ADVANCE: {
    store_products: null, name: 'ADVANCE', price: 699, rank: 5,
    links_per_month: null, link_expiry_days: null, max_amount: 10000, commission: 1,
    webhooks: null, api_orders: true, api_docs: true, advanced_api: false,
    accounts: { fampay: 3, paytm_mid: 3, amazon: 3 },
    custom_pages: true, qr_theme: true, branding: true, multiple_pages: true
  },
  ELITE: {
    store_products: null, name: 'ELITE', price: 999, rank: 6,
    links_per_month: null, link_expiry_days: null, max_amount: null, commission: 0,
    webhooks: null, api_orders: true, api_docs: true, advanced_api: true,
    accounts: { fampay: 3, paytm_mid: 3, amazon: 3 },
    custom_pages: true, qr_theme: true, branding: true, multiple_pages: true
  }
};

const ORDER = Object.keys(PLANS);
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const lookup = (name) => PLANS[String(name || '').trim().toUpperCase()] || null;

class PlanError extends Error {
  constructor(message, code = 'PLAN_LIMIT', status = 403) { super(message); this.code = code; this.status = status; }
}

// Merchant ka asli (abhi chalu) plan. Expired / unknown (purana "Blaze") / row nahi -> FREE.
async function getMerchantPlan(merchantId) {
  const { data: row } = await supabase.from('merchant_plans').select('*').eq('merchant_id', merchantId).maybeSingle();
  let plan = lookup(row && row.plan_name);
  let expired = false;
  if (plan && plan.price > 0) {
    const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (!exp || exp <= Date.now()) { plan = null; expired = true; }
  }
  return { plan: plan || PLANS.FREE, expired, row: row || null, expires_at: plan && plan.price > 0 ? row.expires_at : null };
}

// ---------- simple checks (sab PlanError throw karte hain) ----------
function assertAmount(plan, amount, what = 'payment') {
  if (plan.max_amount !== null && Number(amount) > plan.max_amount) {
    throw new PlanError(`${plan.name} plan allows maximum ${inr(plan.max_amount)} per ${what}. Upgrade your plan to accept higher amounts.`, 'PLAN_AMOUNT_LIMIT');
  }
}

function assertApi(plan) {
  if (!plan.api_orders) {
    throw new PlanError(`API access is not included in the ${plan.name} plan. Upgrade to BASIC or higher.`, 'PLAN_API_DISABLED');
  }
}

function assertFeature(plan, feature, label, needed) {
  if (!plan[feature]) throw new PlanError(`${label} is not available in the ${plan.name} plan. Upgrade to ${needed} or higher.`, 'PLAN_FEATURE');
}

function accountLimit(plan, type) {
  return (plan.accounts && plan.accounts[type]) || 0;
}

function assertAccountType(plan, type, label) {
  if (accountLimit(plan, type) <= 0) {
    throw new PlanError(`${label || type} accounts cannot be connected on the ${plan.name} plan.`, 'PLAN_ACCOUNT_LIMIT');
  }
}

function assertAccountCount(plan, type, existingCount, label) {
  assertAccountType(plan, type, label);
  const lim = accountLimit(plan, type);
  if (existingCount >= lim) {
    throw new PlanError(`${plan.name} plan allows ${lim} ${label || type} account${lim > 1 ? 's' : ''}. Upgrade your plan to connect more.`, 'PLAN_ACCOUNT_LIMIT');
  }
}

function linkExpiryDate(plan) {
  return plan.link_expiry_days === null ? null : new Date(Date.now() + plan.link_expiry_days * DAY).toISOString();
}

function commissionPercent(plan) { return plan.commission; }

// ---------- monthly link counter (atomic-ish: optimistic update, 4 retries) ----------
async function reserveLink(merchantId, plan) {
  if (plan.links_per_month === null) return { reserved: false };
  for (let attempt = 0; attempt < 4; attempt++) {
    let { data: row } = await supabase.from('merchant_plans').select('*').eq('merchant_id', merchantId).maybeSingle();
    if (!row) {
      await supabase.from('merchant_plans').insert([{ merchant_id: merchantId, plan_name: plan.name, links_used: 0, cycle_started_at: new Date().toISOString() }]);
      ({ data: row } = await supabase.from('merchant_plans').select('*').eq('merchant_id', merchantId).maybeSingle());
      if (!row) break;
    }
    let used = Number(row.links_used) || 0;
    let cycleStart = new Date(row.cycle_started_at || row.created_at || Date.now()).getTime();
    let resetting = false;
    if (Date.now() - cycleStart >= DURATION_DAYS * DAY) { used = 0; resetting = true; }
    if (used >= plan.links_per_month) {
      throw new PlanError(`Monthly payment link limit reached (${plan.links_per_month}/month on ${plan.name}). Upgrade your plan or wait for the next cycle.`, 'PLAN_LINK_LIMIT');
    }
    const patch = { links_used: used + 1 };
    if (resetting) patch.cycle_started_at = new Date().toISOString();
    const { data: upd } = await supabase.from('merchant_plans').update(patch)
      .eq('merchant_id', merchantId).eq('links_used', Number(row.links_used) || 0).select();
    if (upd && upd.length) return { reserved: true, prev: Number(row.links_used) || 0, next: used + 1 };
  }
  throw new PlanError('Please try again in a moment.', 'PLAN_BUSY', 409);
}

async function releaseLink(merchantId, token) {
  if (!token || !token.reserved) return;
  await supabase.from('merchant_plans').update({ links_used: Math.max(0, token.next - 1) })
    .eq('merchant_id', merchantId).eq('links_used', token.next);
}

// ---------- webhooks: legacy merchants.webhook_url + merchant_webhooks table ----------
async function listWebhookUrls(merchant) {
  const urls = [];
  if (merchant.webhook_url) urls.push(merchant.webhook_url);
  const { data } = await supabase.from('merchant_webhooks').select('id, url, created_at').eq('merchant_id', merchant.id);
  (data || []).forEach((w) => { if (!urls.includes(w.url)) urls.push(w.url); });
  return { urls, rows: data || [] };
}

// Payment event sab allowed webhooks par bhejo (plan limit se zyada kabhi nahi). Fire-and-forget.
async function sendWebhooks(merchant, payload) {
  try {
    const { plan } = await getMerchantPlan(merchant.id);
    if (!plan.api_orders) return 0;               // FREE: webhooks band
    let { urls } = await listWebhookUrls(merchant);
    if (plan.webhooks !== null) urls = urls.slice(0, plan.webhooks);
    urls.forEach((u) => {
      fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
    });
    return urls.length;
  } catch { return 0; }
}

// Plan ke hisaab se checkout look: jo feature plan me nahi, uski settings ignore (downgrade ke baad bhi strict)
function effectiveBrandingMerchant(merchant, plan) {
  if (!merchant) return merchant;
  const m = { ...merchant };
  if (!plan.custom_pages && !plan.qr_theme) { m.checkout_theme = null; m.checkout_color = null; m.checkout_shape = null; m.checkout_font = null; }
  if (!plan.branding) { m.checkout_brand_name = null; m.checkout_logo_url = null; m.checkout_footer = null; }
  return m;
}

// Kya merchant ye plan kharid sakta hai? (chalu paid plan se sasta nahi)
async function checkCanBuy(merchantId, target) {
  if (!target || target.price <= 0) return { ok: false, message: 'FREE plan is the default plan. It starts automatically when a paid plan ends.' };
  const { plan: current, expires_at } = await getMerchantPlan(merchantId);
  if (current.price > 0 && target.rank < current.rank) {
    return { ok: false, message: `Your ${current.name} plan is active until ${new Date(expires_at).toLocaleDateString('en-IN')}. You can switch to ${target.name} after it ends.` };
  }
  return { ok: true, current, expires_at };
}

// Plan chalu karo (payment ho chuka). Same plan renew = baaki time + 30 din, warna aaj se 30 din.
async function activatePlan(merchantId, target) {
  const { plan: current, row, expires_at } = await getMerchantPlan(merchantId);
  let planRowId = null;
  const { data: pr } = await supabase.from('plans').select('id').eq('name', target.name).maybeSingle();
  if (pr) planRowId = pr.id;
  const base = current.name === target.name && expires_at && new Date(expires_at) > new Date() ? new Date(expires_at).getTime() : Date.now();
  const newExpiry = new Date(base + DURATION_DAYS * DAY).toISOString();
  const fields = { plan_name: target.name, expires_at: newExpiry, links_used: 0, withdrawals_used: 0, cycle_started_at: new Date().toISOString() };
  if (planRowId) fields.plan_id = planRowId;
  let error;
  if (row) ({ error } = await supabase.from('merchant_plans').update(fields).eq('merchant_id', merchantId));
  else ({ error } = await supabase.from('merchant_plans').insert([{ merchant_id: merchantId, ...fields }]));
  if (error) throw error;
  await supabase.from('merchants').update({ plan_name: target.name, plan_expires_at: newExpiry }).eq('id', merchantId);
  return { expires_at: newExpiry };
}

// PlanError ho to JSON response bhej do aur true return karo
function fail(res, err) {
  if (err instanceof PlanError) {
    res.status(err.status).json({ success: false, code: err.code, message: err.message });
    return true;
  }
  return false;
}

function publicPlan(p) {
  return { ...p, developer_portal: !!p.api_orders, accounts: { ...p.accounts }, duration_days: DURATION_DAYS };
}

module.exports = {
  PLANS, ORDER, DURATION_DAYS, DAY, PlanError, lookup, getMerchantPlan,
  assertAmount, assertApi, assertFeature, assertAccountType, assertAccountCount, accountLimit,
  linkExpiryDate, commissionPercent, reserveLink, releaseLink,
  listWebhookUrls, sendWebhooks, effectiveBrandingMerchant, publicPlan, fail, checkCanBuy, activatePlan
};
