/**
 * 邮件发送服务（SMTP 可配置；未配置时降级写日志不真发）
 * .env: SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM
 */
require('dotenv').config();
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* 未安装则降级 */ }

/**
 * 发送邮件
 * @param {Object} opts { to, subject, text }
 * @returns {Promise<{delivered: boolean}>} delivered=false 表示 SMTP 未配置/失败，已降级日志
 */
async function sendMail({ to, subject, text }) {
  const host = process.env.SMTP_HOST;
  if (!host || !nodemailer) {
    console.log(`[邮件降级] SMTP 未配置或未安装 nodemailer：to=${to} subject=${subject}\n${text}`);
    return { delivered: false };
  }
  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || (process.env.SMTP_USER || 'p390@local'),
      to,
      subject,
      text,
    });
    return { delivered: true };
  } catch (e) {
    console.error('[邮件发送失败]', e.message);
    return { delivered: false };
  }
}

module.exports = { sendMail };
