const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER_EMAIL,
    pass: process.env.GMAIL_REFRESH_TOKEN
  }
});

// Send OTP email
const sendOTP = async (email, otp) => {
  try {
    await transporter.sendMail({
      from: `"HamroPay" <${process.env.GMAIL_USER_EMAIL}>`,
      to: email,
      subject: 'Your HamroPay Login OTP',
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:auto;padding:2rem;background:#0f172a;color:#f8fafc;border-radius:12px;">
          <h2 style="color:#6366f1">HamroPay</h2>
          <p>Your OTP for login:</p>
          <div style="font-size:2rem;font-weight:900;letter-spacing:8px;color:#6366f1;margin:1rem 0">${otp}</div>
          <p style="color:#94a3b8;font-size:0.875rem">Valid for 10 minutes. Do not share this OTP.</p>
        </div>
      `
    });
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
};

// Send password reset email
const sendPasswordReset = async (email, token) => {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  try {
    await transporter.sendMail({
      from: `"HamroPay" <${process.env.GMAIL_USER_EMAIL}>`,
      to: email,
      subject: 'Reset Your HamroPay Password',
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:auto;padding:2rem;background:#0f172a;color:#f8fafc;border-radius:12px;">
          <h2 style="color:#6366f1">HamroPay</h2>
          <p>Click below to reset your password:</p>
          <a href="${resetUrl}" style="display:inline-block;margin:1rem 0;padding:0.75rem 1.5rem;background:#6366f1;color:white;border-radius:8px;text-decoration:none;font-weight:700">Reset Password</a>
          <p style="color:#94a3b8;font-size:0.875rem">Valid for 30 minutes. Ignore if you didn't request this.</p>
        </div>
      `
    });
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
};

module.exports = { sendOTP, sendPasswordReset };