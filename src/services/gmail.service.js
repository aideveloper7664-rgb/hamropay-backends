const imapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
require('dotenv').config();

// Connect to Gmail via IMAP
const connectIMAP = async (email, password) => {
  const config = {
    imap: {
      user: email,
      password: password.replace(/\s/g, ''),
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
      connTimeout: 15000
    }
  };
  return await imapSimple.connect(config);
};

// Verify UTR using admin Gmail
const verifyUTR = async (utr, amount, sinceTs = null) => {
  return await verifyUTRWithCredentials(
    utr,
    amount,
    process.env.GMAIL_USER_EMAIL,
    process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_REFRESH_TOKEN,
    sinceTs
  );
};

// Verify UTR using merchant Gmail
const verifyUTRWithCredentials = async (utr, amount, gmailEmail, appPassword, sinceTs = null) => {
  let connection = null;
  try {
    connection = await connectIMAP(gmailEmail, appPassword);
    await connection.openBox('INBOX');

    // Same as PHP script — narrow to FamX subject
    const searchCriteria = [['SUBJECT', 'FamX account']];
    const fetchOptions = {
      bodies: ['TEXT', 'HEADER'],
      markSeen: false,
      struct: true
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    connection.end();

    if (!messages || messages.length === 0) {
      return null;
    }

    // Last 30 emails — newest first (same as PHP rsort)
    const recent = messages.slice(-30).reverse();

    for (const msg of recent) {
      // Get email timestamp
      const headerPart = msg.parts.find(p => p.which === 'HEADER');
      const emailDate = headerPart?.body?.date?.[0];
      const emailTs = emailDate ? Math.floor(new Date(emailDate).getTime() / 1000) : null;

      // Reject old emails — same as PHP (90 sec buffer)
      if (sinceTs && emailTs && emailTs < (sinceTs - 90)) continue;

      // Get body
      const textPart = msg.parts.find(p => p.which === 'TEXT');
      if (!textPart) continue;

      let body = textPart.body || '';

      // Decode base64 if needed
      try {
        const decoded = Buffer.from(body, 'base64').toString('utf8');
        if (decoded.length > 0) body = decoded;
      } catch (e) {}

      // Strip HTML tags
      body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      // Amount pattern — same as PHP: "received ₹X"
      const amountMatch = body.match(/received\s+(?:₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/ui);
      if (!amountMatch) continue;

      const emailAmount = parseFloat(amountMatch[1].replace(',', ''));
      if (Math.abs(emailAmount - parseFloat(amount)) > 0.009) continue;

      // UTR pattern — same as PHP
      let extractedUTR = null;
      const utrMatch = body.match(/UTR[:\s]+(\d+)/i);
      if (utrMatch) extractedUTR = utrMatch[1];

      // Txn ID pattern — same as PHP
      let txnId = null;
      const txnMatch = body.match(/transaction\s+id\s+([A-Z0-9]+)/i);
      if (txnMatch) txnId = txnMatch[1];

      const identifier = extractedUTR || txnId;
      if (!identifier) continue;

      // Match UTR — same as PHP mode=utr
      const typed = utr;
      const matches = (extractedUTR === typed) || (txnId === typed) || body.includes(typed);
      if (!matches) continue;

      // Extract sender name — same as PHP
      const senderMatch = body.match(/from\s+([A-Za-z][A-Za-z0-9\s]{1,40}?)\s+at\s+\d/ui);
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