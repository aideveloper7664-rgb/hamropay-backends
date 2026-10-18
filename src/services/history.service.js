const imapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');

const FAMPAY_SUBJECT = 'You have successfully received';
const CACHE_TTL_MS = 10 * 1000; // Sync button spam se Gmail/Render ko bachane ke liye
const HARD_TIMEOUT_MS = 25 * 1000;

const cache = new Map();     // key -> { ts, data }
const inflight = new Map();  // key -> Promise (same merchant ki parallel requests ek hi baar chalen)

const toNumber = (s) => parseFloat(String(s).replace(/,/g, ''));

function cleanText(mail) {
  let text = mail.text || '';
  if (!text && mail.html) text = String(mail.html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

// FamPay email text se fields nikalna (best-effort: jo field na mile wo null)
function parseFamPayEmail(text, subject = '') {
  const hay = `${subject} ${text}`;

  const amountMatch = hay.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
  if (!amountMatch) return null;
  const amount = toNumber(amountMatch[1]);
  if (!(amount > 0)) return null;

  const utr = (text.match(/UTR\s*(?:No\.?|Number)?\s*[:\-]?\s*(\d{10,})/i) || [])[1] || null;
  const txnId = (text.match(/Transaction\s*ID\s*[:\-]?\s*([A-Z0-9]{6,})/i) || [])[1] || null;
  const reference = utr || txnId;

  let sender = null;
  const senderMatch = text.match(/\bfrom\s+([A-Za-z][A-Za-z0-9 .&'-]{1,40}?)(?=\s+(?:on|via|using|with|through|to|at|UPI|Rs|₹|UTR|Transaction)\b|[.,]|$)/i);
  if (senderMatch) {
    const cand = senderMatch[1].trim();
    if (!/^(your|the|a|an|fampay|upi|bank)\b/i.test(cand)) sender = cand;
  }

  const purposeMatch = text.match(/(?:Purpose|Remarks?|Note|Message)\s*[:\-]\s*(.{1,60}?)(?=\s+(?:UTR|Transaction|Amount|Date|Sender|From|Balance|Your|You|Thank)\b|[.]|$)/i);
  const purpose = purposeMatch ? purposeMatch[1].trim() : null;

  const balMatch = text.match(/Balance\s*(?:is|:|-)?\s*(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
  const balance = balMatch ? toNumber(balMatch[1]) : null;

  return { amount, reference, alt_reference: reference === utr ? txnId : utr, sender, purpose, balance };
}

async function connect(email, appPassword) {
  return imapSimple.connect({
    imap: {
      user: email,
      password: String(appPassword).replace(/\s/g, ''),
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { servername: 'imap.gmail.com' },
      authTimeout: 10000,
      connTimeout: 15000
    }
  });
}

async function loadHistory({ email, appPassword, days, limit, debug, before }) {
  let connection = null;
  try {
    connection = await connect(email, appPassword);
    await connection.openBox('INBOX');

    const DAY = 24 * 60 * 60 * 1000;
    const windowEnd = before ? new Date(before) : null;                       // null = abhi tak
    const since = new Date((windowEnd ? windowEnd.getTime() : Date.now()) - days * DAY);
    const criteria = [['SUBJECT', FAMPAY_SUBJECT], ['SINCE', since]];
    if (windowEnd) criteria.push(['BEFORE', windowEnd]);

    const messages = await connection.search(criteria, { bodies: [''], markSeen: false });
    connection.end();
    connection = null;

    const total = (messages || []).length;
    const truncated = total > limit;                                          // is window me limit se zyada emails thi
    const recent = (messages || []).slice(-limit).reverse(); // newest first
    const transactions = [];
    const seen = new Set();
    let debugSample = null;

    for (const msg of recent) {
      const raw = msg.parts.find(p => p.which === '')?.body;
      if (!raw) continue;

      let mail;
      try { mail = await simpleParser(raw); } catch { continue; }

      const text = cleanText(mail);
      if (debug && !debugSample) debugSample = { subject: mail.subject || '', text: text.slice(0, 600) };

      const parsed = parseFamPayEmail(text, mail.subject || '');
      if (!parsed) continue;

      const key = parsed.reference || `${parsed.amount}-${mail.date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      transactions.push({
        reference: parsed.reference,
        alt_reference: parsed.alt_reference || null,
        message_id: mail.messageId || null,
        amount: parsed.amount,
        sender: parsed.sender || 'NA',
        purpose: parsed.purpose || null,
        date: mail.date ? new Date(mail.date).toISOString() : null,
        balance_after: parsed.balance
      });
    }

    const latestBalance = transactions.find(t => t.balance_after !== null)?.balance_after ?? null;

    // Agla (purana) window kahan se shuru ho. Truncated ho to usi din tak wapas aao (us din ki baaki emails na chhootein).
    let nextBefore = since;
    if (truncated) {
      const dates = transactions.map(t => t.date).filter(Boolean).map(d => new Date(d).getTime());
      if (dates.length) nextBefore = new Date(Math.min(...dates) + DAY);
    }

    const result = {
      transactions: transactions.map(({ balance_after, ...t }) => t),
      stats: {
        shown: transactions.length,
        total_amount: Math.round(transactions.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        balance: latestBalance,            // null = email me balance nahi mila
        last_synced: new Date().toISOString(),
        window_days: days
      },
      window: {
        from: since.toISOString(),
        to: windowEnd ? windowEnd.toISOString() : null,
        truncated,
        next_before: nextBefore.toISOString()   // "Load older" isi ko ?before= me bhejo
      }
    };
    if (debug) result.debug_sample = debugSample;
    return result;
  } finally {
    if (connection) { try { connection.end(); } catch {} }
  }
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (err?.code === 'GMAIL_TIMEOUT') return { status: 504, code: 'GMAIL_TIMEOUT', message: 'Gmail took too long to respond. Please try again.' };
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|Application-specific password/i.test(msg) || err?.textCode === 'AUTHENTICATIONFAILED') {
    return { status: 502, code: 'GMAIL_AUTH', message: 'Gmail login failed. Check the App Password and that IMAP is enabled in Gmail settings.' };
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
    return { status: 502, code: 'GMAIL_NETWORK', message: 'Could not reach Gmail. Please try again.' };
  }
  return { status: 502, code: 'GMAIL_ERROR', message: 'Could not read Gmail right now. Please try again.' };
}

// cacheKey = `${merchantId}:${cashierId}`
async function getFamPayHistory(cacheKey, opts) {
  const { days = 30, limit = 50, debug = false, ttlMs = CACHE_TTL_MS } = opts;

  const hit = cache.get(cacheKey);
  if (!debug && hit && Date.now() - hit.ts < ttlMs) {
    return { ...hit.data, cached: true };
  }
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const job = (async () => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => { const e = new Error('timeout'); e.code = 'GMAIL_TIMEOUT'; rej(e); }, HARD_TIMEOUT_MS);
    });
    try {
      const data = await Promise.race([loadHistory({ ...opts, days, limit, debug }), timeout]);
      if (!debug) cache.set(cacheKey, { ts: Date.now(), data });
      return data;
    } finally {
      clearTimeout(timer);
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, job);
  return job;
}

module.exports = { getFamPayHistory, parseFamPayEmail, friendlyError };