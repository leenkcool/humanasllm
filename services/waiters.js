/**
 * 内存等待者（通用单例工厂）
 * 用于 /v1/chat/completions 与 /v1/approvals 挂起等待人工/审批结果
 *
 * 任务与审批各自实例化（id 均为自增数字，key 可能冲突，避免共用同一 store）
 */
function createWaiterStore() {
  const waiters = new Map();

  return {
    /**
     * 注册等待者并返回 Promise
     * @param {*} id
     * @param {number} timeoutMs 超时时间（毫秒）
     * @param {Function} [onTimeout] 超时时的兜底返回
     */
    wait(id, timeoutMs, onTimeout) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          resolve(onTimeout ? onTimeout() : { timedOut: true });
        }, timeoutMs);
        waiters.set(id, { resolve, timer });
      });
    },

    /** 唤醒等待者并返回结果 */
    resolve(id, result) {
      const w = waiters.get(id);
      if (w) {
        clearTimeout(w.timer);
        waiters.delete(id);
        w.resolve(result);
      }
    },

    /** 查询等待者（不删除） */
    get(id) { return waiters.get(id); },

    /** 清除等待者（不唤醒） */
    clear(id) {
      const w = waiters.get(id);
      if (w) {
        clearTimeout(w.timer);
        waiters.delete(id);
      }
    },

    /** 当前挂起数量 */
    size() { return waiters.size; },
  };
}

module.exports = { createWaiterStore };
