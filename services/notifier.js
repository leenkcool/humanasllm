/**
 * 通知渠道服务（治理层：工程师离线不再=任务超时）
 * .env: NOTIFY_EMAIL_TO（逗号分隔，可选）/ NOTIFY_WEBHOOK_URL（企微/钉钉文本 webhook，可选）
 * 触发：新任务 / 超时 / 审批待办 / 审批超时。均降级安全（未配置或发送失败不阻塞主流程）。
 */
require('dotenv').config();
const { sendMail } = require('./mailer');

const WORKBENCH_URL = 'http://192.168.168.3:39000/login.html';

function enabled() {
  return !!(process.env.NOTIFY_EMAIL_TO || process.env.NOTIFY_WEBHOOK_URL);
}

/**
 * 发送通知（邮件 + webhook）
 * @param {Object} opts { event, title, text, taskId }
 */
async function send({ event, title, text, taskId }) {
  const to = process.env.NOTIFY_EMAIL_TO;
  const webhook = process.env.NOTIFY_WEBHOOK_URL;
  const link = `${WORKBENCH_URL}${taskId ? ` (task_id: ${taskId})` : ''}`;
  if (to) {
    await sendMail({ to, subject: `[p390] ${title}`, text: `${text}\n\n${link}` })
      .catch((e) => console.error('[通知邮件失败]', e.message));
  }
  if (webhook) {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `[p390] ${title}\n${text}\n${link}` } }),
    }).catch((e) => console.error('[Webhook 通知失败]', e.message));
  }
}

module.exports = { enabled, send };
