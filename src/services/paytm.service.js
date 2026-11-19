// Paytm official Transaction Status API (v3) — MID + Merchant Key se signed POST.
// Docs: https://paytmpayments.com/docs/api/v3/transaction-status-api/
//
// HamroPay me checkout session_id hi Paytm ORDERID maana jaata hai (UPI link me tr=<session_id> jaata hai).
// Merchant Key kabhi plain me store/log nahi hoti (DB me AES encrypted, checkout.service.encryptSecret).
const crypto = require('crypto');

const API_BASE = (process.env.PAYTM_API_BASE || 'https://securegw.paytm.in').replace(/\/+$/, '');
const IV = '@@@@&&&&####$$$$';        // Paytm checksum ka fixed IV (official paytmchecksum library jaisa)
const TIMEOUT_MS = 8000;
const CACHE_MS = 3000;                // checkout page har ~3s poll karta hai: Paytm ko spam na ho

const cache = new Map();              // `${mid}:${orderId}` -> { ts, data }

// Official PaytmChecksum.generateSignature(string, key) jaisa: sha256(body|salt)+salt ko AES-128-CBC se encrypt
function signature(bodyString, merchantKey) {
  const salt = crypto.randomBytes(3).toString('base64');   // 4 chars
  const hash = crypto.createHash('sha256').update(`${bodyString}|${salt}`).digest('hex') + salt;
  const cipher = crypto.createCipheriv('aes-128-cbc', merchantKey, IV);   // key exactly 16 chars honi chahiye
  return cipher.update(hash, 'binary', 'base64') + cipher.final('base64');
}

async function getOrderStatus(mid, merchantKey, orderId, { fresh = false } = {}) {
  const ck = `${mid}:${orderId}`;
  const hit = cache.get(ck);
  if (!fresh && hit && Date.now() - hit.ts < CACHE_MS) return hit.data;

  const body = { mid, orderId };
  const payload = { body, head: { signature: signature(JSON.stringify(body), merchantKey) } };

  const res = await fetch(`${API_BASE}/v3/order/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await res.json().catch(() => null);
  const b = (json && json.body) || {};
  const info = b.resultInfo || {};

  const data = {
    http: res.status,
    hasResult: !!b.resultInfo,
    resultStatus: info.resultStatus || null,      // TXN_SUCCESS | TXN_FAILURE | PENDING | NO_RECORD_FOUND ...
    resultCode: info.resultCode || null,
    resultMsg: info.resultMsg || null,
    orderId: b.orderId || null,
    txnId: b.txnId || null,
    bankTxnId: b.bankTxnId || null,
    amount: b.txnAmount !== undefined && b.txnAmount !== null ? parseFloat(b.txnAmount) : null
  };
  cache.set(ck, { ts: Date.now(), data });
  if (cache.size > 500) { for (const k of cache.keys()) { cache.delete(k); if (cache.size <= 250) break; } }
  return data;
}

// Payment tabhi paid jab: Paytm ne TXN_SUCCESS bola + wahi order + amount match
function isPaid(r, orderId, expectedAmount) {
  return !!r &&
    r.resultStatus === 'TXN_SUCCESS' &&
    (!r.orderId || r.orderId === orderId) &&
    r.amount !== null && Math.abs(r.amount - Number(expectedAmount)) < 0.005 &&
    !!(r.bankTxnId || r.txnId);
}

// Account connect karte waqt: MID + Merchant Key sach me kaam karte hain ya nahi.
// Ek anjaan order id ka status poochte hain: signature/MID galat ho to Paytm usi ka error deta hai,
// sahi ho to "order nahi mila" type jawab aata hai.
// Return: { ok: true } | { ok: false, reason, message }
async function checkCredentials(mid, merchantKey) {
  let r;
  try {
    r = await getOrderStatus(mid, merchantKey, 'HPCONNECT' + crypto.randomBytes(5).toString('hex'), { fresh: true });
  } catch (e) {
    return { ok: false, reason: 'NETWORK', message: 'Could not reach Paytm to verify these credentials. Please try again shortly.' };
  }
  if (!r.hasResult) {
    return { ok: false, reason: 'UNEXPECTED', message: 'Paytm gave an unexpected response. Check the Merchant ID and Merchant Key.' };
  }
  const msg = r.resultMsg || '';
  if (/checksum|signature/i.test(msg)) {
    return { ok: false, reason: 'KEY_INVALID', message: 'Paytm rejected the Merchant Key. Copy it again from your Paytm Business dashboard.' };
  }
  if (/\bmid\b|merchant/i.test(msg)) {
    return { ok: false, reason: 'MID_INVALID', message: 'Paytm could not find this Merchant ID. Check it and try again.' };
  }
  // "order not found / invalid order id" = credentials theek, bas ye order exist nahi karta
  if (r.resultCode === '334' || /order|no record/i.test(msg) || r.resultStatus) {
    return { ok: true };
  }
  return { ok: false, reason: 'UNEXPECTED', message: 'Could not verify these credentials with Paytm. Check them and try again.' };
}

module.exports = { getOrderStatus, isPaid, checkCredentials };
