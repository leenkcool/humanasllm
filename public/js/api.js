/* api.js — 请求封装（token 自动注入、401 跳登录） */
window.HLM = window.HLM || {};

(function () {
  const { toast } = window.HLM.U;
  const { t, acceptHeader } = window.HLM.I18n;

  function getToken() { return localStorage.getItem('hlm_token'); }
  function getBase() { return window.location.origin + '/api'; }

  async function request(method, url, body) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Accept-Language': acceptHeader() };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(getBase() + url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON */ }

    if (res.status === 401) {
      localStorage.removeItem('hlm_token');
      localStorage.removeItem('hlm_user');
      if (window.location.pathname.indexOf('login.html') < 0) window.location.href = '/login.html';
      throw new Error(data?.message || data?.error || t('api.expired'));
    }
    if (!res.ok) {
      throw new Error(data?.message || data?.error || t('api.requestFail'));
    }
    return data;
  }

  const api = {
    get: (u) => request('GET', u),
    post: (u, b) => request('POST', u, b),
    put: (u, b) => request('PUT', u, b),
    del: (u) => request('DELETE', u),
  };

  window.HLM.API = api;
})();
