const { google } = require('googleapis');
require('dotenv').config();

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

const verifyUTR = async (utr, amount) => {
  try {
    // Search FamPay emails in last 30 min
    const query = `from:noreply@fampay.in subject:"successfully received" newer_than:1h`;

    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20
    });

    if (!data.messages || data.messages.length === 0) {
      return null;
    }

    // Check each email
    for (const msg of data.messages) {
      const { data: email } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const body = getEmailBody(email);

      // Check UTR match
      if (body.includes(utr)) {
        // Check amount match
        const amountMatch = body.match(/₹\s*([\d,]+\.?\d*)/);
        if (amountMatch) {
          const emailAmount = parseFloat(amountMatch[1].replace(',', ''));
          if (emailAmount === parseFloat(amount)) {
            return { messageId: msg.id, verified: true };
          }
        }
      }
    }

    return null;
  } catch (err) {
    console.error('Gmail verify error:', err.message);
    return null;
  }
};

const getEmailBody = (email) => {
  let body = '';

  if (email.payload.parts) {
    for (const part of email.payload.parts) {
      if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
        if (part.body.data) {
          body += Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
    }
  } else if (email.payload.body.data) {
    body = Buffer.from(email.payload.body.data, 'base64').toString('utf-8');
  }

  return body;
};

module.exports = { verifyUTR };
const verifyUTRWithCredentials = async (utr, amount, gmailEmail, appPassword) => {
  try {
    const nodemailer = require('nodemailer');
    const Imap = require('imap-simple');

    const config = {
      imap: {
        user: gmailEmail,
        password: appPassword,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 10000
      }
    };

    const connection = await Imap.connect(config);
    await connection.openBox('INBOX');

    const searchCriteria = [
      'UNSEEN',
      ['FROM', 'noreply@fampay.in'],
      ['SINCE', new Date(Date.now() - 60 * 60 * 1000)]
    ];

    const fetchOptions = { bodies: ['TEXT', 'HEADER'], markSeen: false };
    const messages = await connection.search(searchCriteria, fetchOptions);

    for (const msg of messages) {
      const body = msg.parts.find(p => p.which === 'TEXT');
      if (body && body.body.includes(utr)) {
        const amountMatch = body.body.match(/₹\s*([\d,]+\.?\d*)/);
        if (amountMatch) {
          const emailAmount = parseFloat(amountMatch[1].replace(',', ''));
          if (emailAmount === parseFloat(amount)) {
            connection.end();
            return { messageId: msg.attributes.uid, verified: true };
          }
        }
      }
    }

    connection.end();
    return null;
  } catch (err) {
    console.error('Merchant Gmail verify error:', err.message);
    // Fallback to admin Gmail
    return await verifyUTR(utr, amount);
  }
};

module.exports = { verifyUTR, verifyUTRWithCredentials };
