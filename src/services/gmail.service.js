const imapSimple = require('imap-simple');
require('dotenv').config();

const connectIMAP = async (email, password) => {
  const configs = [
    { host: 'imap.gmail.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false } },
    { host: 'imap.gmail.com', port: 993, tls: true },
  ];

  for (const imapConfig of configs) {
    try {
      const connection = await imapSimple.connect({
        imap: {
          user: email,
          password: password.replace(/\s/g, ''),
          authTimeout: 10000,
          connTimeout: 15000,
          ...imapConfig
        }
      });
      return connection;
    } catch (e) {
      continue;
    }
  }
  throw new Error('IMAP connection failed');
};

// Verify UTR using admin Gmail
const verifyUTR = async (utr, amount, sinceTs = null) => {
  return await verifyUTRWithCredentials(
    utr,
    amount,
    process.env.GMAIL_USER_EMAIL,
    process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_REFRESH_TOKEN,
    sinceTs,
    'fampay'
  );
};

// Verify UTR using merchant Gmail
const verifyUTRWithCredentials = async (utr, amount, gmailEmail, appPassword, sinceTs = null, type = 'fampay') => {
  let connection = null;
  try {
    connection = await connectIMAP(gmailEmail, appPassword);
    await connection.openBox('INBOX');

    // Subject filter based on type
    let searchCriteria;
    if (type === 'fampay') {
      searchCriteria = [['SUBJECT', 'You have successfully received']];
    } else if (type === 'paytm') {
      searchCriteria = [['SUBJECT', 'You have received a payment']];
    } else {
      searchCriteria = [['SUBJECT', 'You have successfully received']];
    }

    const fetchOptions = {
      bodies: ['TEXT', 'HEADER'],
      markSeen: false
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    connection.end();
    connection = null;

    if (!messages || messages.length === 0) return null;

    // Last 30 emails — newest first
    const recent = messages.slice(-30).reverse();

    for (const msg of recent) {
      // Get timestamp
      const headerPart = msg.parts.find(p => p.which === 'HEADER');
      const emailDate = headerPart?.body?.date?.[0];
      const emailTs = emailDate ? Math.floor(new Date(emailDate).getTime() / 1000) : null;

      // Reject old emails (90 sec buffer)
      if (sinceTs && emailTs && emailTs < (sinceTs - 90)) continue;

      // Get body
      const textPart = msg.parts.find(p => p.which === 'TEXT');
      if (!textPart) continue;

      let body = textPart.body || '';

      // Try base64 decode
      try {
        const decoded = Buffer.from(body, 'base64').toString('utf8');
        if (decoded.length > 10) body = decoded;
      } catch (e) {}

      // Strip HTML
      body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      // Amount pattern — FamPay: "₹150.0"
      const amountMatch = body.match(/(?:₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/ui);
      if (!amountMatch) continue;

      const emailAmount = parseFloat(amountMatch[1].replace(',', ''));
      if (Math.abs(emailAmount - parseFloat(amount)) > 0.009) continue;

      // UTR pattern — FamPay: "UTR : 623851978381"
      let extractedUTR = null;
      const utrMatch = body.match(/UTR\s*[:\s]+(\d{10,})/i);
      if (utrMatch) extractedUTR = utrMatch[1];

      // Transaction ID — FamPay: "FMPIB6477798764"
      let txnId = null;
      const txnMatch = body.match(/(?:Transaction\s+ID|transaction\s+id)\s*[:\s]+([A-Z0-9]+)/i);
      if (txnMatch) txnId = txnMatch[1];

      const identifier = extractedUTR || txnId;
      if (!identifier) continue;

      // Match UTR
      const typed = utr;
      const matches = (extractedUTR === typed) || (txnId === typed) || body.includes(typed);
      if (!matches) continue;

      // Extract sender name
      const senderMatch = body.match(/from\s+([A-Za-z][A-Za-z0-9\s]{1,40}?)\s/ui);
      const sender = senderMatch ? senderMatch[1].trim() : 'Unknown';

      return {
        messageId: msg.attributes.uid,
        verified: true,
        utr: identifier,
        amount: emailAmount,
        sender
      };
    }

    return null;
  } catch (err) {
    console.error('Gmail IMAP verify error:', err.message);
    if (connection) {
      try { connection.end(); } catch(e) {}
    }
    return null;
  }
};

// Verify Paytm payment via Paytm API
const verifyPaytmPayment = async (mid, orderId, expectedAmount) => {
  try {
    const https = require('https');
    const JsonData = JSON.stringify({ MID: mid, ORDERID: orderId });

    return new Promise((resolve, reject) => {
      const url = `https://securegw.paytm.in/order/status?JsonData=${encodeURIComponent(JsonData)}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (
              response.STATUS === 'TXN_SUCCESS' &&
              response.MID === mid &&
              response.ORDERID === orderId &&
              Math.abs(parseFloat(response.TXNAMOUNT) - parseFloat(expectedAmount)) < 0.01
            ) {
              resolve({
                verified: true,
                utr: response.BANKTXNID,
                amount: parseFloat(response.TXNAMOUNT),
                txnId: response.TXNID
              });
            } else {
              resolve(null);
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  } catch (err) {
    console.error('Paytm verify error:', err.message);
    return null;
  }
};

module.exports = { verifyUTR, verifyUTRWithCredentials, verifyPaytmPayment };