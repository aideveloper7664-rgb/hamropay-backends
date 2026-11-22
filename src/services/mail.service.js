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

function otpEmail(code, { isNew, purpose, minutes }) {
  purpose = purpose || (isNew ? 'signup' : 'login');
  const BRAND = '#4f46e5';
  const heading = { signup: 'Verify your email', login: 'Your login code', reset: 'Reset your password' }[purpose] || 'Your verification code';
  const intro = {
    signup: 'Welcome to HamroPay! Enter this code to finish creating your account.',
    login: 'Use this code to log in to your HamroPay account.',
    reset: 'Use this code to set a new password for your HamroPay account.'
  }[purpose] || 'Use this code to continue.';
  const digits = String(code).split('').map((d) =>
    `<td style="padding:0 3px"><div style="width:42px;height:54px;line-height:54px;text-align:center;font-size:28px;font-weight:700;font-family:'Courier New',monospace;color:#111827;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px">${esc(d)}</div></td>`
  ).join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(code)} is your HamroPay code. Expires in ${minutes} minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.06)">
<tr><td style="background:${BRAND};padding:22px 28px">
<span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:.3px">Hamro<span style="color:#c7d2fe">Pay</span></span>
</td></tr>
<tr><td style="padding:30px 28px 8px">
<h1 style="margin:0 0 8px;font-size:22px;color:#111827">${esc(heading)}</h1>
<p style="margin:0;font-size:15px;line-height:1.5;color:#4b5563">${esc(intro)}</p>
</td></tr>
<tr><td align="center" style="padding:22px 28px 6px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>${digits}</tr></table>
</td></tr>
<tr><td style="padding:14px 28px 4px">
<p style="margin:0;text-align:center;font-size:13px;color:#6b7280">This code expires in <b style="color:#111827">${minutes} minutes</b>.</p>
</td></tr>
<tr><td style="padding:18px 28px 28px">
<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.5;color:#9a3412">
&#128274; Never share this code with anyone. HamroPay will never ask for it.</div>
</td></tr>
<tr><td style="border-top:1px solid #eef0f3;padding:16px 28px;background:#fafafa">
<p style="margin:0;font-size:12px;line-height:1.5;color:#9ca3af">If you did not request this, you can safely ignore this email. Someone may have typed your email by mistake.</p>
<p style="margin:8px 0 0;font-size:12px;color:#9ca3af">&copy; HamroPay &middot; Secure UPI payments</p>
</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${intro}\n\nYour code: ${code}\nThis code expires in ${minutes} minutes. Never share it with anyone.\n\nIf you did not request this, ignore this email.`;
  return { subject: purpose === 'signup' ? `${code} is your HamroPay verification code` : purpose === 'reset' ? `${code} is your HamroPay password reset code` : `${code} is your HamroPay login code`, html, text };
}

module.exports = { sendMail, otpEmail, MailError, provider };
