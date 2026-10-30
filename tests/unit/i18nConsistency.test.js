/**
 * 单元测试：前端 i18n 词条中英一致性
 *
 * 背景：i18n.js 的 zh / en 是两份独立的扁平字典，只加一边会导致中英混排。
 * 本测试长期锁死两边的 key 集合必须完全相等（含新增功能的 key）。
 *
 * 实现：用 vm 在沙箱里执行 i18n.js（它只依赖 window / localStorage / document），
 * 直接读出两份字典对比，无需浏览器环境。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', 'public', 'js', 'i18n.js');

function loadDicts() {
  const code = fs.readFileSync(SRC, 'utf8');
  const store = {};
  const sandbox = {
    window: { HLM: {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      documentElement: { lang: 'zh-CN' },
      querySelectorAll: () => [],
      querySelector: () => null,
      title: '',
    },
    navigator: { language: 'zh-CN' },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: SRC });
  return sandbox.window.HLM.I18n.DICTS;
}

const DICTS = loadDicts();
const zhKeys = Object.keys(DICTS.zh);
const enKeys = Object.keys(DICTS.en);

test('i18n：zh / en key 集合完全一致', () => {
  const onlyZh = zhKeys.filter(k => !(k in DICTS.en));
  const onlyEn = enKeys.filter(k => !(k in DICTS.zh));
  assert.deepStrictEqual(onlyZh, [], `仅中文有：${onlyZh.join(', ')}`);
  assert.deepStrictEqual(onlyEn, [], `仅英文有：${onlyEn.join(', ')}`);
});

test('i18n：无空值', () => {
  const empty = [...zhKeys, ...enKeys].filter(k => {
    const v = DICTS.zh[k] !== undefined ? DICTS.zh[k] : DICTS.en[k];
    return typeof v !== 'string' || !v.trim();
  });
  assert.deepStrictEqual([...new Set(empty)], [], '存在空词条');
});

test('i18n：新增功能词条齐全（模板 / 派单 / 告警 / 计费）', () => {
  const required = [
    // 模板
    'nav.templates', 'tpl.name', 'tpl.create', 'tpl.use', 'tpl.saved',
    // 派单
    'dispatch.title', 'dispatch.recommend', 'dispatch.assign', 'dispatch.noCandidate',
    // 告警
    'nav.alerts', 'alerts.tab.active', 'alerts.ack', 'alerts.resolve', 'toast.alertNew',
    // 计费
    'nav.billing', 'billing.statement', 'billing.rates', 'billing.ledger', 'billing.settle',
    // 合规报告
    'audit.exportPdf', 'audit.popupBlocked',
  ];
  const missing = required.filter(k => !(k in DICTS.zh) || !(k in DICTS.en));
  assert.deepStrictEqual(missing, [], `缺失词条：${missing.join(', ')}`);
});

test('i18n：占位符两边一致（{n} / {id} 等）', () => {
  const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
  const mismatch = zhKeys
    .filter(k => k in DICTS.en)
    .filter(k => ph(DICTS.zh[k]) !== ph(DICTS.en[k]))
    .map(k => `${k}: zh[${ph(DICTS.zh[k])}] en[${ph(DICTS.en[k])}]`);
  assert.deepStrictEqual(mismatch, [], '占位符不一致：\n' + mismatch.join('\n'));
});
