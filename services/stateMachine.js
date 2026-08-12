/**
 * 状态机定义与校验（任务 / 审批）
 * 独立单例：所有状态流转统一在此定义与校验，避免散落各处
 *
 * 任务：pending → processing → completed | returned | paused
 *      returned → pending(重派) | processing | cancelled
 *      completed → returned(打回重做)
 *      pending → completed(AI 降级代答直达终态)
 * 审批：pending → approved | rejected
 */
const TASK_TRANSITIONS = {
  pending: ['processing', 'returned', 'cancelled', 'completed'],
  processing: ['completed', 'returned', 'paused'],
  returned: ['pending', 'processing', 'cancelled'],
  paused: ['processing', 'returned', 'cancelled'],
  completed: ['returned'],
  cancelled: [],
};

const APPROVAL_TRANSITIONS = {
  pending: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

/** 校验 from → to 是否合法 */
function validateTransition(transitions, from, to) {
  const allowed = transitions[from] || [];
  return allowed.includes(to);
}

/** 创建状态机实例 */
function createStateMachine(transitions) {
  return {
    transitions,
    /** from → to 是否可流转 */
    can(from, to) { return validateTransition(transitions, from, to); },
    /** from 的合法去向 */
    allowed(from) { return transitions[from] || []; },
  };
}

module.exports = { TASK_TRANSITIONS, APPROVAL_TRANSITIONS, validateTransition, createStateMachine };
