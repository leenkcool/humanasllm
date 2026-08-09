/**
 * WebSocket 事件推送工具
 * 其他模块通过这个服务发送实时通知
 */

let io = null;

function setIO(socketIO) {
  io = socketIO;
}

// 推送通知给指定用户
function notifyUser(userId, event, data) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

// 推送给所有管理员
function notifyAdmins(event, data) {
  if (!io) return;
  io.to('admin').emit(event, data);
}

// 广播给所有人
function broadcast(event, data) {
  if (!io) return;
  io.to('system').emit(event, data);
}

// 推送通知消息（标准格式）
function pushNotification(userId, notification) {
  notifyUser(userId, 'notification', {
    id: notification.id,
    title: notification.title,
    content: notification.content,
    type: notification.type,
    created_at: notification.created_at
  });
}

// 推送任务状态变更
function pushTaskEvent(taskData) {
  broadcast(`task:${taskData.event}`, {
    id: taskData.id,
    name: taskData.name,
    status: taskData.status,
    message: taskData.message,
    timestamp: new Date().toISOString()
  });
}

// 推送系统告警
function pushSystemAlert(alert) {
  broadcast('system:alert', {
    level: alert.level || 'warning',
    title: alert.title,
    message: alert.message,
    timestamp: new Date().toISOString()
  });
}

// 推送备份进度
function pushBackupProgress(userId, progress) {
  notifyUser(userId, 'backup:progress', {
    id: progress.id,
    status: progress.status, // running/success/failed
    percent: progress.percent,
    message: progress.message,
    filename: progress.filename
  });
}

// 推送导入进度
function pushImportProgress(userId, progress) {
  notifyUser(userId, 'import:progress', {
    type: progress.type,
    status: progress.status,
    total: progress.total,
    processed: progress.processed,
    success: progress.success,
    failed: progress.failed,
    errors: progress.errors
  });
}

module.exports = {
  setIO, notifyUser, notifyAdmins, broadcast,
  pushNotification, pushTaskEvent, pushSystemAlert,
  pushBackupProgress, pushImportProgress
};
