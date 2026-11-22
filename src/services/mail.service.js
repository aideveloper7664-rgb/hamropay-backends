// Email bhejne ka HTTP API (Render free plan SMTP ports block karta hai, isliye SMTP nahi).
// .env: MAIL_PROVIDER=brevo|resend, BREVO_API_KEY ya RESEND_API_KEY, MAIL_FROM_EMAIL, MAIL_FROM_NAME
class MailError extends Error { constructor(message, code = 'MAIL_FAILED') { super(message); this.code = code; } }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function provider() {
  const p = (process.env.MAIL_PROVIDER || '').toLowerCase();
  if (p === 'resend' || (!p && process.env.RESEND_API_KEY && !process.env.BREVO_API_KEY)) return 'resend';
  if (p === 'brevo' || process.env.BREVO_API_KEY) return 'brevo';
  return null;
}

async function sendMail({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM_EMAIL;
  const name = process.env.MAIL_FROM_NAME || 'HamroPay';
  const prov = provider();
  if (!prov || !from) throw new MailError('Email service is not configured', 'MAIL_NOT_CONFIGURED');

  let res;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    if (prov === 'brevo') {
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: ctl.signal,
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { email: from, name }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
      });
    } else {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${name} <${from}>`, to: [to], subject, html, text })
      });
    }
    clearTimeout(timer);
  } catch (e) {
    throw new MailError('Could not reach the email service', 'MAIL_NETWORK');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch { /* ignore */ }
    console.error(`[mail] ${prov} ${res.status} ${detail}`);
    throw new MailError('Email service rejected the message', 'MAIL_REJECTED');
  }
  return true;
}

function otpEmail(code, { isNew, minutes }) {
  const title = isNew ? 'Verify your email to create your HamroPay account' : 'Your HamroPay login code';
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
<h2 style="margin:0 0 8px;color:#111">HamroPay</h2>
<p style="color:#333">${esc(title)}:</p>
<div style="font-size:34px;letter-spacing:8px;font-weight:700;background:#f5f5f7;border-radius:10px;padding:14px;text-align:center;color:#111">${esc(code)}</div>
<p style="color:#555;font-size:13px">This code expires in ${minutes} minutes. Never share it with anyone — HamroPay will never ask for it.</p>
<p style="color:#999;font-size:12px">If you did not request this, you can safely ignore this email.</p></div>`;
  const text = `${title}: ${code}\nThis code expires in ${minutes} minutes. Never share it with anyone.`;
  return { subject: isNew ? `${code} is your HamroPay verification code` : `${code} is your HamroPay login code`, html, text };
}

module.exports = { sendMail, otpEmail, MailError, provider };
