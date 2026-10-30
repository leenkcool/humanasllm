/**
 * UI 回归检查（真实浏览器，puppeteer）
 *
 * 用途：改完前端后一条命令跑完「12 个页面 × 控制台错误 / 内容渲染 / 主题 / 中英 / 移动端 / PWA」，
 * 输出报告与截图，不依赖肉眼逐页点。
 *
 * 用法：
 *   npm start                 # 先起服务（39000）
 *   npm run ui:check          # → data/ui-shots/report.json + *.png
 *
 * 环境变量：
 *   UI_BASE   默认 http://127.0.0.1:39000
 *   UI_OUT    默认 data/ui-shots
 *   UI_USER / UI_PASS  默认 admin / admin123
 *   UI_HEADFUL=1       显示浏览器窗口（调试用）
 *
 * 退出码：发现 console 错误 / 页面空白 / 横向溢出 / SW 未注册 时返回 1。
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.UI_BASE || 'http://127.0.0.1:39000';
const OUT = path.resolve(process.env.UI_OUT || path.join(__dirname, '..', 'data', 'ui-shots'));
const USER = process.env.UI_USER || 'admin';
const PASS = process.env.UI_PASS || 'admin123';
const HEADFUL = process.env.UI_HEADFUL === '1';
// PWA 校验必须用安全上下文；127.0.0.1 也算 secure context，但 localhost 最稳
const PWA_BASE = BASE.replace('127.0.0.1', 'localhost');

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), base: BASE, pages: {}, problems: [] };

function attach(page, bucket) {
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push({ type: 'console.error', text: m.text() });
  });
  page.on('pageerror', (e) => bucket.push({ type: 'pageerror', text: String((e && e.message) || e) }));
  page.on('requestfailed', (r) => bucket.push({ type: 'requestfailed', text: r.url() + ' :: ' + ((r.failure() && r.failure().errorText) || '') }));
  page.on('response', (r) => {
    // 401 在未登录探测中属预期；只记 4xx/5xx 的静态资源与接口
    if (r.status() >= 400) bucket.push({ type: 'http' + r.status(), text: r.request().method() + ' ' + r.url() });
  });
}

const PAGES = ['dashboard', 'queue', 'mine', 'logs', 'approvals', 'alerts',
  'projects', 'templates', 'billing', 'gateway', 'prd', 'users'];

(async () => {
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN'],
    defaultViewport: { width: 1440, height: 900 },
  });

  // ---------- 1. 登录 ----------
  const lp = await browser.newPage();
  const loginErr = [];
  attach(lp, loginErr);
  const login = {};
  try {
    const resp = await lp.goto(BASE + '/login.html', { waitUntil: 'networkidle2', timeout: 20000 });
    login.status = resp && resp.status();
    await lp.screenshot({ path: path.join(OUT, 'login.png') });
    await lp.type('input[name=username], #username, input[type=text]', USER, { delay: 15 });
    await lp.type('input[type=password], #password', PASS, { delay: 15 });
    await Promise.all([
      lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
      lp.click('button[type=submit], .btn.primary, #loginBtn'),
    ]);
    await sleep(1200);
    login.hasToken = await lp.evaluate(() => !!localStorage.getItem('hlm_token'));
    if (!login.hasToken) report.problems.push('登录失败：未拿到 token');
  } catch (e) {
    login.fatal = String(e.message);
    report.problems.push('登录页异常：' + e.message);
  }
  login.errors = loginErr;
  report.pages.login = login;
  await lp.close();

  // ---------- 2. 逐页 ----------
  const p = await browser.newPage();
  const pageErrs = [];
  attach(p, pageErrs);
  await p.goto(BASE + '/workbench.html', { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(1000);

  for (const id of PAGES) {
    const before = pageErrs.length;
    await p.evaluate((h) => { location.hash = h; }, '#/' + id);
    await sleep(1600);
    const info = await p.evaluate(() => {
      const c = document.getElementById('content');
      const txt = (c ? c.innerText : '').replace(/\s+/g, ' ').trim();
      return {
        contentLen: txt.length,
        title: (document.querySelector('.page-title') || {}).textContent || '',
        tables: document.querySelectorAll('#content table').length,
        cards: document.querySelectorAll('#content .card').length,
        hasErrorText: /undefined|NaN|\[object Object\]/.test(txt),
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    });
    try { await p.screenshot({ path: path.join(OUT, id + '.png') }); } catch (e) { info.shotErr = String(e.message); }
    info.errors = pageErrs.slice(before);
    report.pages[id] = info;

    if (info.contentLen < 20) report.problems.push(`页面 #/${id} 内容为空`);
    if (info.hasErrorText) report.problems.push(`页面 #/${id} 出现 undefined/NaN/[object Object]`);
    if (info.scrollW > info.innerW + 1) report.problems.push(`页面 #/${id} 横向溢出 ${info.scrollW} > ${info.innerW}`);
    const realErrs = info.errors.filter(e => !/http401/.test(e.type));
    if (realErrs.length) report.problems.push(`页面 #/${id} 控制台报错：${realErrs.map(e => e.text).join(' | ').slice(0, 300)}`);
  }

  // ---------- 3. 任务详情 + 智能派单面板 ----------
  await p.evaluate(() => { location.hash = '#/queue'; });
  await sleep(1500);
  const detail = {};
  try {
    // 必须挑「待接单」任务：智能派单面板只对 pending/returned 显示
    const pendingId = await p.evaluate(() => {
      for (const tr of document.querySelectorAll('#content table.data tbody tr')) {
        if (!tr.querySelector('button[onclick*="\'claim\'"]') && !tr.querySelector('button[onclick*="claim("]')) continue;
        const btn = tr.querySelector('button[onclick*="openDetail("]');
        if (!btn) continue;
        const m = btn.getAttribute('onclick').match(/openDetail\((\d+)\)/);
        if (m) return m[1];
      }
      return null;
    });
    detail.pendingId = pendingId;
    if (!pendingId) {
      detail.note = '队列无待接单任务，跳过派单面板检查';
    }
    if (pendingId) {
      await p.evaluate((id) => window.HLM.UI.openDetail(parseInt(id, 10)), pendingId);
      await sleep(2500);
      detail.dispatch = await p.evaluate(() => {
        const b = document.getElementById('dispatchBox');
        if (!b) return { panel: false };
        return { panel: true, rows: b.querySelectorAll('.dispatch-row').length, text: b.innerText.trim().slice(0, 200) };
      });
      await p.screenshot({ path: path.join(OUT, 'task-detail.png') });
      if (!detail.dispatch.panel) report.problems.push('任务详情缺少智能派单面板');
      else if (detail.dispatch.rows === 0) report.problems.push('智能派单面板无候选人');
      await p.evaluate(() => window.HLM.U.closeModal());
    }
  } catch (e) {
    detail.fatal = String(e.message);
    report.problems.push('任务详情检查异常：' + e.message);
  }
  report.taskDetail = detail;

  // ---------- 4. 主题（4 套） ----------
  await p.evaluate(() => { location.hash = '#/alerts'; });
  await sleep(1200);
  const themes = {};
  for (const th of ['light', 'warm', 'mori', 'dark']) {
    const ok = await p.evaluate((id) => {
      const b = Array.from(document.querySelectorAll('[data-theme-btn]')).find(x => x.dataset.themeBtn === id);
      if (!b) return false;
      b.click();
      return true;
    }, th);
    await sleep(400);
    themes[th] = {
      clicked: ok,
      applied: await p.evaluate(() => document.body.dataset.theme),
    };
    if (th === 'dark') await p.screenshot({ path: path.join(OUT, 'alerts-dark.png') });
    if (!ok || themes[th].applied !== th) report.problems.push(`主题 ${th} 切换失败`);
  }
  report.themes = themes;
  await p.evaluate(() => { const b = document.querySelector('[data-theme-btn=light]'); if (b) b.click(); });
  await sleep(300);

  // ---------- 5. 中英切换（新页面不得残留硬编码中文） ----------
  const probeChinese = async (pageId) => {
    await p.evaluate((h) => { location.hash = h; }, '#/' + pageId);
    await sleep(1500);
    return p.evaluate((pageId) => {
      // 跳过用户数据与动态内容容器，只查界面文案
      const SKIP = ['mono', 'ctx', 'msg-row', 'dispatch-row', 'tag', 'chip', 'empty'];
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const s = (n.nodeValue || '').trim();
        if (!s || !/[一-龥]/.test(s)) continue;
        const el = n.parentElement;
        if (!el) continue;
        // 任一祖先隐藏（含未打开的弹窗 .overlay 不带 .show）都不算可见文案
        if (el.closest('[hidden], .overlay:not(.show)')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const cls = String(el.className || '');
        if (SKIP.some(c => cls.split(/\s+/).includes(c))) continue;
        if (el.closest('.sidebar-foot')) continue;
        // 动态数据容器：任务表格摘要列 / 工程师名 / 模板内容 / 日志正文 / 顶部用户名徽标
        if (el.closest('table.data tbody, .modal-body, #engBox, #govBox, #alertStats, #userName, #userRole')) continue;
        // 模板卡片整体是用户数据（名称/描述/预置需求）
        if (pageId === 'templates' && el.closest('#templatesBox .card-body')) continue;
        out.push(s.slice(0, 50));
      }
      return [...new Set(out)].slice(0, 30);
    }, pageId);
  };
  const lang = { targets: ['alerts', 'templates', 'billing', 'queue', 'dashboard'] };
  await p.evaluate(() => window.HLM.App.switchLang());
  await sleep(1200);
  lang.after = await p.evaluate(() => window.HLM.I18n.lang());
  lang.residualChinese = {};
  for (const id of lang.targets) {
    const left = await probeChinese(id);
    lang.residualChinese[id] = left;
    if (left.length) report.problems.push(`#/${id} 英文界面残留中文：${left.join(' / ')}`);
  }
  await p.evaluate(() => window.HLM.App.switchLang());
  await sleep(800);
  report.lang = lang;

  // ---------- 6. 移动端（390×844） ----------
  const m = await browser.newPage();
  const mErr = [];
  attach(m, mErr);
  await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await m.goto(BASE + '/workbench.html#/dashboard', { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(1500);
  const mobile = {};
  mobile.bottomNav = await m.evaluate(() => {
    const n = document.getElementById('bottomNav');
    if (!n) return { exists: false };
    return {
      exists: true,
      display: getComputedStyle(n).display,
      items: Array.from(n.querySelectorAll('.bn-item')).map(a => a.dataset.page),
    };
  });
  mobile.overflow = await m.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    offenders: Array.from(document.querySelectorAll('body *'))
      .map(e => ({ e, r: e.getBoundingClientRect() }))
      .filter(x => x.r.right > window.innerWidth + 1 && x.r.width > 0)
      .slice(0, 5).map(x => x.e.tagName + '.' + String(x.e.className || '').slice(0, 30))
  }));
  await m.screenshot({ path: path.join(OUT, 'mobile-dashboard.png') });
  mobile.canNavigate = await m.evaluate(() => {
    const a = document.querySelector('#bottomNav .bn-item[data-page=queue]');
    if (!a) return false;
    a.click();
    return true;
  });
  await sleep(1500);
  mobile.afterHash = await m.evaluate(() => location.hash);
  await m.screenshot({ path: path.join(OUT, 'mobile-queue.png') });
  mobile.errors = mErr;

  if (!mobile.bottomNav.exists) report.problems.push('移动端缺少底部导航');
  else if (mobile.bottomNav.display === 'none') report.problems.push('移动端底部导航被隐藏');
  if (mobile.overflow.scrollW > mobile.overflow.innerW + 1) {
    report.problems.push(`移动端横向溢出：${mobile.overflow.offenders.join(', ')}`);
  }
  if (!mobile.canNavigate || mobile.afterHash !== '#/queue') report.problems.push('底部导航点击未跳转');
  report.mobile = mobile;
  await m.close();

  // ---------- 7. PWA（localhost 安全上下文） ----------
  const pw = await browser.newPage();
  const pwErr = [];
  attach(pw, pwErr);
  const pwa = {};
  try {
    await pw.goto(PWA_BASE + '/workbench.html', { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(2500);
    pwa.secure = await pw.evaluate(() => window.isSecureContext);
    pwa.manifest = await pw.evaluate(() => {
      const l = document.querySelector('link[rel=manifest]');
      return l ? l.getAttribute('href') : null;
    });
    pwa.registrations = await pw.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const rs = await navigator.serviceWorker.getRegistrations();
      return rs.map(r => ({ scope: r.scope, state: r.active && r.active.state }));
    });
    pwa.controller = await pw.evaluate(() => (navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null));
    if (!pwa.secure) report.problems.push('PWA 检查：当前非安全上下文（用 localhost 访问）');
    else if (!Array.isArray(pwa.registrations) || !pwa.registrations.some(r => r.state === 'activated')) {
      report.problems.push('Service Worker 未激活');
    }
  } catch (e) {
    pwa.fatal = String(e.message);
    report.problems.push('PWA 检查异常：' + e.message);
  }
  pwa.errors = pwErr;
  report.pwa = pwa;
  await pw.close();

  // ---------- 8. 工程师终端（移动优先） ----------
  const mt = await browser.newPage();
  const mtErr = [];
  attach(mt, mtErr);
  const terminal = {};
  try {
    await mt.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    // 未登录访问应跳登录页并带 next 回跳参数。
    // 同一浏览器上下文可能已带 token（前面的页面登录过），此时不会跳转属正常，跳过该断言。
    await mt.goto(BASE + '/mobile.html', { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(800);
    const hadToken = await mt.evaluate(() => !!localStorage.getItem('hlm_token'));
    terminal.redirectWhenAnonymous = hadToken
      ? '已有 token，跳过匿名跳转检查'
      : await mt.evaluate(() => location.pathname + location.search);

    // 清掉 token 后重新走匿名流程，确保真正覆盖未登录跳转
    if (hadToken) {
      await mt.evaluate(() => localStorage.clear());
      await mt.goto(BASE + '/mobile.html', { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(800);
      terminal.redirectWhenAnonymous = await mt.evaluate(() => location.pathname + location.search);
    }

    // 登录（复用当前会话的 token 更稳；直接走页面登录）
    await mt.goto(BASE + '/login.html?next=' + encodeURIComponent('/mobile.html'), { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(500);
    await mt.type('input[name=username], #username, input[type=text]', USER, { delay: 15 });
    await mt.type('input[type=password], #password', PASS, { delay: 15 });
    await Promise.all([
      mt.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
      mt.click('button[type=submit], .btn.primary, #loginBtn'),
    ]);
    await sleep(1800);
    terminal.afterLoginPath = await mt.evaluate(() => location.pathname);

    terminal.cards = await mt.evaluate(() => document.querySelectorAll('.m-card').length);
    terminal.emptyText = await mt.evaluate(() => {
      const e = document.querySelector('.m-empty');
      return e ? e.innerText.trim() : null;
    });
    terminal.tabs = await mt.evaluate(() => Array.from(document.querySelectorAll('[data-mtab]')).map(b => b.dataset.mtab));
    terminal.overflow = await mt.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    }));
    await mt.screenshot({ path: path.join(OUT, 'mobile-terminal.png') });

    // 有任务时点开第一张卡，确认抽屉与答复区渲染
    if (terminal.cards > 0) {
      await mt.evaluate(() => {
        const b = document.querySelector('.m-card .btn');
        if (b) b.click();
      });
      await sleep(1500);
      terminal.drawerOpen = await mt.evaluate(() => {
        const d = document.getElementById('mDrawer');
        return d ? d.classList.contains('show') : false;
      });
      await mt.screenshot({ path: path.join(OUT, 'mobile-terminal-detail.png') });
    } else {
      terminal.drawerOpen = 'no-tasks';
    }
    terminal.errors = mtErr;

    if (!String(terminal.redirectWhenAnonymous).startsWith('/login.html')) {
      report.problems.push('终端页未登录时未跳转登录页');
    }
    if (terminal.afterLoginPath !== '/mobile.html') {
      report.problems.push(`终端登录后未回跳（停留在 ${terminal.afterLoginPath}）`);
    }
    if (terminal.overflow.scrollW > terminal.overflow.innerW + 1) {
      report.problems.push(`终端页横向溢出 ${terminal.overflow.scrollW} > ${terminal.overflow.innerW}`);
    }
    if (!terminal.tabs || terminal.tabs.length < 2) report.problems.push('终端页缺少标签切换');
    const mtReal = mtErr.filter(e => !/http401/.test(e.type));
    if (mtReal.length) report.problems.push('终端页控制台报错：' + mtReal.map(e => e.text).join(' | ').slice(0, 200));
  } catch (e) {
    terminal.fatal = String(e.message);
    report.problems.push('工程师终端检查异常：' + e.message);
  }
  report.terminal = terminal;
  await mt.close();

  await browser.close();
  report.finishedAt = new Date().toISOString();
  report.ok = report.problems.length === 0;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('\n===== UI 回归结果 =====');
  console.log(`页面：${PAGES.length} 个，截图目录：${OUT}`);
  if (report.ok) {
    console.log('✅ 全部通过（无控制台错误 / 无空白页 / 无横向溢出 / 中英无残留 / PWA 已激活）');
  } else {
    console.log(`❌ 发现 ${report.problems.length} 个问题：`);
    report.problems.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
  }
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error('UI 检查致命错误：', e); process.exit(1); });
