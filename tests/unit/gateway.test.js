const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const gw = require('../../routes/gateway');

test('renderTemplate 替换默认网关与占位符', () => {
  const out = gw.renderTemplate(
    'http://localhost:39000/api/x <baseUrl> <model> http://127.0.0.1:39000 http://localhost:39000',
    { baseUrl: 'https://gw.acme.com', model: 'human-llm' });
  assert.ok(out.includes('https://gw.acme.com/api/x'));
  assert.ok(out.includes('https://gw.acme.com human-llm'), '占位替换后相邻');
  assert.ok(!out.includes('localhost'));
  assert.ok(!out.includes('127.0.0.1'));
  assert.ok(!out.includes('localhost:39000'));
});

test('safeTarget 越界目标被拒', () => {
  const base = path.resolve('/opt/p390/installed');
  assert.throws(() => gw.safeTarget(base, '../../escape'), /越界/);
  assert.throws(() => gw.safeTarget(base, 'a/../../escape'), /越界/);
});

test('safeTarget 合法目标落在安装根内', () => {
  const base = path.resolve('/opt/p390/installed');
  const abs = gw.safeTarget(base, 'projA');
  assert.ok(abs.startsWith(base + path.sep));
  assert.ok(abs.endsWith('projA'));
  assert.strictEqual(gw.safeTarget(base, ''), base);
});

