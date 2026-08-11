/**
 * 后端 i18n —— 按 Accept-Language 翻译用户可见 message
 * 纯增量：包装 res.json，把 body.message / body.error / body.data.message 中文化成英文。
 * 默认（无 Accept-Language 或非 en）完全透传，不影响现有中文行为。
 */

// ===== 中文 → 英文 字典 =====
const EN = {
  // middleware/auth
  '未提供认证令牌': 'Missing authentication token',
  '令牌已过期': 'Token expired',
  '无效的认证令牌': 'Invalid authentication token',
  '权限不足': 'Insufficient permissions',
  // middleware/security
  '请求过于频繁，请稍后再试': 'Too many requests, please try again later',
  'CORS 策略拒绝该来源': 'CORS policy rejected this origin',
  // server
  '接口不存在': 'Endpoint not found',
  '服务器内部错误': 'Internal server error',

  // auth
  '用户名、邮箱、密码不能为空': 'Username, email and password are required',
  '邮箱格式不正确': 'Invalid email format',
  '用户名或邮箱已存在': 'Username or email already exists',
  '注册成功，待管理员审核启用': 'Registered successfully, awaiting admin approval',
  '注册失败': 'Registration failed',
  '请输入注册邮箱': 'Please enter your registered email',
  '该邮箱未注册': 'This email is not registered',
  '新密码已发送至你的邮箱': 'New password sent to your email',
  '邮件服务未配置，密码已重置（见响应 demoPassword）': 'Email service not configured; password reset (see demoPassword in response)',
  '重置密码失败': 'Password reset failed',
  '用户名和密码不能为空': 'Username and password are required',
  '用户名或密码错误': 'Invalid username or password',
  '账户已被禁用': 'Account disabled',
  '登录失败': 'Login failed',
  '用户不存在': 'User not found',
  '获取用户失败': 'Failed to fetch user',
  '旧密码和新密码不能为空': 'Old and new passwords are required',
  '新密码至少 6 位': 'New password must be at least 6 characters',
  '旧密码不正确': 'Old password is incorrect',
  '密码修改成功': 'Password updated',
  '修改密码失败': 'Password update failed',
  '已登出': 'Logged out',

  // tasks
  '任务不存在': 'Task not found',
  '获取任务列表失败': 'Failed to fetch task list',
  '获取任务详情失败': 'Failed to fetch task detail',
  '接单失败': 'Claim failed',
  '提交内容不能为空': 'Submission content cannot be empty',
  '提交失败': 'Submit failed',
  '请填写驳回原因': 'Please provide a reject reason',
  '驳回失败': 'Reject failed',
  '暂停失败': 'Pause failed',
  '恢复失败': 'Resume failed',
  '重新派发失败': 'Re-dispatch failed',
  '取消失败': 'Cancel failed',
  '无权限打回该任务': 'No permission to reopen this task',
  '请填写打回原因': 'Please provide a reopen reason',
  '打回失败': 'Reopen failed',
  '设置归属项目失败': 'Failed to set task project',
  '项目不存在': 'Project not found',
  // queueService 质检
  '疑似占位/乱答复，请提交实际实现内容': 'Suspected placeholder/random answer; please submit real content',
  // OpenAI 兼容（任务等待）
  '任务等待超时，任务仍在处理中，可稍后查询': 'Task wait timed out; task still processing, check later',

  // approvals
  'resource 不能为空': 'resource cannot be empty',
  '审批等待超时': 'Approval wait timed out',
  '审批单不存在': 'Approval not found',
  '获取审批列表失败': 'Failed to fetch approval list',
  '获取审批详情失败': 'Failed to fetch approval detail',
  '批准失败': 'Approval action failed',
  '驳回失败': 'Reject failed',
  '导出失败': 'Export failed',
  '审批等待超时，审批单仍在处理中，可稍后查询': 'Approval wait timed out; still processing, check later',

  // projects
  '获取项目列表失败': 'Failed to fetch project list',
  '项目编码和名称不能为空': 'Project code and name are required',
  '项目编码已存在': 'Project code already exists',
  '申请已提交，待管理员审批': 'Application submitted, awaiting admin approval',
  '申请失败': 'Application failed',
  '没有可更新字段': 'No fields to update',

  // logs
  '获取请求日志失败': 'Failed to fetch request logs',
  '获取任务日志失败': 'Failed to fetch task logs',

  // users
  '获取用户列表失败': 'Failed to fetch user list',
  '非法角色': 'Invalid role',
  '用户名已存在': 'Username already exists',
  '创建用户失败': 'Failed to create user',
  '用户已更新': 'User updated',
  '更新用户失败': 'Failed to update user',
  '不能删除自己': 'Cannot delete yourself',
  '用户已删除': 'User deleted',
  '删除用户失败': 'Failed to delete user',

  // workbench
  '获取统计失败': 'Failed to fetch stats',
  '获取我的任务失败': 'Failed to fetch my tasks',
  '获取待接单任务失败': 'Failed to fetch queued tasks',
  '获取治理概览失败': 'Failed to fetch governance overview',
  '获取未完成列表失败': 'Failed to fetch unfinished tasks',

  // rules / tenants / audit / gateway
  '获取规则失败': 'Failed to fetch rules',
  'name 与 keywords 必填': 'name and keywords are required',
  'category 非法': 'Invalid category',
  '新建规则失败': 'Failed to create rule',
  '无更新字段': 'No fields to update',
  '更新规则失败': 'Failed to update rule',
  '删除规则失败': 'Failed to delete rule',
  '获取租户失败': 'Failed to fetch tenants',
  'code 与 name 必填': 'code and name are required',
  '租户 code 已存在': 'Tenant code already exists',
  '创建租户失败': 'Failed to create tenant',
  '生成合规报告失败': 'Failed to generate compliance report',
  '涉密/运维数据仅管理员可导出': 'Confidential/ops data can only be exported by admin',
  '导出数据资产失败': 'Failed to export dataset',
  '生成安装包失败': 'Failed to generate install package',
  '网关地址必填': 'Gateway URL is required',
  '读取失败': 'Failed to read',
  'type 非法': 'Invalid type',
  '审计验证失败': 'Failed to verify audit chain',

  // queueService 验收单（运维/涉密类）
  '运维/涉密任务需附验收说明（做了什么、自检结果）': 'Ops/confidential tasks require an acceptance note (what was done, self-check)',
  '验收说明疑似占位，请填写实际完成情况': 'Acceptance note looks like a placeholder; please describe actual work',
};

// 动态模板消息：前缀 → 英文前缀
const PREFIX_EN = [
  ['非法状态流转:', 'Illegal status transition:'],
  ['产出过短（', 'Output too short ('],
  ['任务被驳回:', 'Task rejected:'],
  ['审批发起失败:', 'Approval creation failed:'],
  ['AI 中继失败:', 'AI relay failed:'],
  ['生成失败: ', 'Generation failed: '],
  ['审批已受理，可通过 ', 'Approval accepted; query via '],
];

function toEn(msg) {
  if (EN[msg]) return EN[msg];
  for (const [pre, en] of PREFIX_EN) {
    if (msg.indexOf(pre) === 0) return en + msg.slice(pre.length);
  }
  return msg;
}

function isEn(req) {
  const al = req.headers['accept-language'] || '';
  return al.toLowerCase().indexOf('en') === 0;
}

function translateJson(req, res, next) {
  if (!isEn(req)) return next();
  const origJson = res.json.bind(res);
  res.json = function (body) {
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string') body.message = toEn(body.message);
      if (typeof body.error === 'string') body.error = toEn(body.error);
      if (body.data && typeof body.data.message === 'string') body.data.message = toEn(body.data.message);
    }
    return origJson(body);
  };
  next();
}

module.exports = { translateJson, toEn };
