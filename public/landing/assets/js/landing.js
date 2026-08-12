/* Human as Agent 落地页交互（IIFE，无依赖）
 * 滚动高亮导航 / 锚点平滑 / 移动端菜单 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var navLinks = $('#navLinks');
  var burger = $('#navBurger');

  // 移动端菜单
  if (burger && navLinks) {
    burger.addEventListener('click', function () {
      var open = navLinks.classList.toggle('open');
      burger.setAttribute('aria-expanded', open);
    });
    // 点菜单链接后收起
    navLinks.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') navLinks.classList.remove('open');
    });
  }

  // 滚动：高亮当前区块对应导航项
  var sections = Array.prototype.map.call(document.querySelectorAll('main section[id]'), function (s) {
    return { id: s.id, top: 0 };
  });
  var links = Array.prototype.map.call(navLinks.querySelectorAll('a'), function (a) {
    return { el: a, id: a.getAttribute('href').slice(1) };
  });

  function onScroll() {
    var y = window.scrollY + 100;
    var active = null;
    sections.forEach(function (s) {
      s.top = document.getElementById(s.id).offsetTop;
      if (y >= s.top) active = s.id;
    });
    links.forEach(function (l) {
      var isActive = l.id === active;
      l.el.style.color = isActive ? 'var(--lp-primary)' : '';
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // 引入 foot.html（管理员维护：鸣谢公司/备案号）。留空则不显示。
  fetch('foot.html')
    .then(function (r) { return r.text(); })
    .then(function (t) {
      if (t && t.trim()) {
        var div = document.createElement('div');
        div.className = 'site-foot';
        div.innerHTML = t;
        document.body.appendChild(div);
      }
    })
    .catch(function () { /* 无 foot.html 时忽略 */ });
})();
