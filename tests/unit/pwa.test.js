/**
 * 单元测试：PWA 静态资源
 * 无浏览器环境，只做静态校验（manifest 结构 / SW 关键分支 / 图标存在且尺寸正确）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PUB = path.join(__dirname, '..', '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');

/** 读 PNG 的 IHDR 宽高（不依赖图像库） */
function pngSize(buf) {
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

test('manifest.json：结构完整', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.ok(m.name && m.short_name);
  assert.strictEqual(m.display, 'standalone');
  assert.ok(m.start_url);
  assert.ok(m.theme_color && m.background_color);
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 2);
  const sizes = m.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192'), '需 192 图标');
  assert.ok(sizes.includes('512x512'), '需 512 图标');
  assert.ok(m.icons.some(i => (i.purpose || '').includes('maskable')), '需 maskable 图标');
  assert.ok(Array.isArray(m.shortcuts) && m.shortcuts.length >= 1);
});

test('图标文件存在且 PNG 尺寸正确', () => {
  for (const [file, size] of [['icons/icon-192.png', 192], ['icons/icon-512.png', 512], ['icons/icon-maskable-512.png', 512]]) {
    const buf = fs.readFileSync(path.join(PUB, file));
    const s = pngSize(buf);
    assert.ok(s, `${file} 不是合法 PNG`);
    assert.strictEqual(s.width, size, `${file} 宽度应为 ${size}`);
    assert.strictEqual(s.height, size, `${file} 高度应为 ${size}`);
    assert.strictEqual(s.bitDepth, 8);
  }
});

test('manifest 引用的图标与磁盘文件一一对应', () => {
  const m = JSON.parse(read('manifest.json'));
  for (const icon of m.icons) {
    const p = path.join(PUB, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), `manifest 引用的 ${icon.src} 不存在`);
  }
});

test('sw.js：关键分支齐全（含绝不缓存 API 的护栏）', () => {
  const sw = read('sw.js');
  assert.ok(/addEventListener\(\s*['"]install['"]/.test(sw), '含 install');
  assert.ok(/addEventListener\(\s*['"]activate['"]/.test(sw), '含 activate');
  assert.ok(/addEventListener\(\s*['"]fetch['"]/.test(sw), '含 fetch');
  assert.ok(sw.includes('notificationclick'), '含 notificationclick');
  assert.ok(sw.includes('skipWaiting'), '含 skipWaiting');
  assert.ok(sw.includes('/offline.html'), '含离线页回退');
  // 绝不缓存携带凭据 / 流式数据的路径
  assert.ok(sw.includes('/api/'), '需显式绕过 /api/');
  assert.ok(sw.includes('/v1/'), '需显式绕过 /v1/');
  assert.ok(sw.includes('/socket.io'), '需显式绕过 /socket.io');
  assert.ok(/VERSION\s*=\s*['"]p390-v\d+['"]/.test(sw), '需有缓存版本号');
});

test('sw.js 预缓存清单中的文件均存在', () => {
  const sw = read('sw.js');
  const m = sw.match(/SHELL\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, '找不到 SHELL 数组');
  const paths = [...m[1].matchAll(/['"](\/[^'"]*)['"]/g)].map(x => x[1]);
  assert.ok(paths.length >= 5, '预缓存清单过短');
  const missing = paths.filter(p => {
    if (p.startsWith('/socket.io')) return false; // 运行时注入，不一定静态存在
    return !fs.existsSync(path.join(PUB, p.replace(/^\//, '')));
  });
  assert.deepStrictEqual(missing, [], `预缓存文件缺失：${missing.join(', ')}`);
});

test('pwa.js：导出完整且安全降级', () => {
  const p = read('js/pwa.js');
  for (const fn of ['register', 'enableNotifications', 'notify', 'permission', 'isSecure', 'canNotify']) {
    assert.ok(new RegExp(`${fn}[\\s:]*`).test(p), `缺少 ${fn}`);
  }
  assert.ok(p.includes('serviceWorker') && p.includes('register'), '含 SW 注册');
  assert.ok(p.includes('isSecureContext'), '需检查安全上下文');
  assert.ok(p.includes('try'), '需有 try/catch 降级');
});

test('offline.html：自包含且含重试', () => {
  const h = read('offline.html');
  assert.ok(h.includes('<meta charset="UTF-8">'));
  assert.ok(h.includes('viewport-fit=cover'));
  assert.ok(h.includes('reload()'), '含重试按钮');
  assert.ok(!/<link[^>]+href="\/css/.test(h), '离线页不应依赖外部 CSS');
});

test('workbench.html / login.html：PWA 标签齐全', () => {
  for (const f of ['workbench.html', 'login.html']) {
    const h = read(f);
    assert.ok(h.includes('rel="manifest"'), `${f} 缺 manifest`);
    assert.ok(h.includes('name="theme-color"'), `${f} 缺 theme-color`);
    assert.ok(h.includes('viewport-fit=cover'), `${f} 缺 viewport-fit`);
    assert.ok(h.includes('apple-touch-icon'), `${f} 缺 apple-touch-icon`);
  }
  const wb = read('workbench.html');
  assert.ok(wb.includes('id="bottomNav"'), '工作台缺底部导航容器');
  assert.ok(/\/js\/pwa\.js/.test(wb), '工作台缺 pwa.js');
  // 加载顺序：pwa.js 必须在 app.js 之前
  assert.ok(wb.indexOf('/js/pwa.js') < wb.indexOf('/js/app.js'), 'pwa.js 必须先于 app.js 加载');
});

test('style.css：底部导航只在 ≤768px 显示且用主题变量', () => {
  const css = read('css/style.css');
  assert.ok(css.includes('.bottom-nav { display: none; }') || /\.bottom-nav\s*\{\s*display:\s*none/.test(css),
    '桌面默认隐藏底部导航');
  assert.ok(css.includes('env(safe-area-inset-bottom)'), '含安全区适配');
  assert.ok(/\.bottom-nav[\s\S]{0,2000}var\(--surface\)/.test(css), '底部导航使用主题变量');
  assert.ok(css.includes('min-height: 44px'), '触控目标 ≥44px');
});
