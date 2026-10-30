/* alerts.js — 告警中心：SLA 升级序列 / 审批超时，确认与处理 */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, fmt, toast, confirmDialog, Icons } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  let tab = 'active';   // active | acked | resolved | all
  let page = 1;

  const KIND_LABEL = () => ({
    sla_warn: t('alerts.kind.sla_warn'),
    sla_breach: t('alerts.kind.sla_breach'),
    return_stale: t('alerts.kind.return_stale'),
    approval_overdue: t('alerts.kind.approval_overdue'),
  });

  function levelTag(level) {
    const n = parseInt(level) || 1;
    return `<span class="tag lvl${n}" title="${esc(t('alerts.levelHint', { n }))}">L${n}</span>`;
  }

  function statusTag(status) {
    const map = { active: 'returned', acked: 'medium', resolved: 'completed' };
    return `<span class="tag ${map[status] || 'paused'}">${esc(t('alerts.status.' + status))}</span>`;
  }

  async function load() {
    const box = $('#alertsBox');
    if (!box) return;
    box.innerHTML = `<div class="empty" style="padding:24px;">…</div>`;
    const params = new URLSearchParams({ status: tab, page, size: 20 });
    try {
      const [listR, statsR] = await Promise.all([
        API.get('/alerts?' + params.toString()),
        API.get('/alerts/stats'),
      ]);
      const d = listR.data;
      const s = statsR.data;
      window._activeAlerts = s.active || 0;
      if (window.HLM.App && window.HLM.App.updateBadges) window.HLM.App.updateBadges();

      renderStats(s);
      box.innerHTML = (d.data && d.data.length)
        ? renderList(d.data)
        : `<div class="empty" style="padding:32px;">${t('alerts.empty')}</div>`;
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  function renderStats(s) {
    const box = $('#alertStats');
    if (!box) return;
    const lv = s.by_level || {};
    box.innerHTML = `
      <div class="stat returned"><div class="num">${s.active || 0}</div><div class="lbl">${t('alerts.stat.active')}</div></div>
      <div class="stat pending"><div class="num">${s.acked || 0}</div><div class="lbl">${t('alerts.stat.acked')}</div></div>
      <div class="stat completed"><div class="num">${s.resolved || 0}</div><div class="lbl">${t('alerts.stat.resolved')}</div></div>
      ${[1, 2, 3, 4, 5].map(n => `<div class="stat"><div class="num">${lv[n] || 0}</div><div class="lbl">L${n} ${esc(t('alerts.levelName.' + n))}</div></div>`).join('')}`;
  }

  function renderList(list) {
    return `<div class="tbl-wrap"><table class="data">
      <thead><tr>
        <th>${t('alerts.col.level')}</th><th>${t('alerts.col.kind')}</th><th>${t('alerts.col.title')}</th>
        <th>${t('alerts.col.task')}</th><th>${t('alerts.col.status')}</th><th>${t('alerts.col.created')}</th><th>${t('table.action')}</th>
      </tr></thead><tbody>${list.map(a => `
        <tr>
          <td class="nowrap">${levelTag(a.level)}</td>
          <td class="nowrap">${esc((KIND_LABEL())[a.kind] || a.kind)}</td>
          <td>${esc(a.title)}${a.detail ? `<div style="font-size:11px;color:var(--muted);">${esc(a.detail)}</div>` : ''}</td>
          <td class="nowrap">${a.task_id ? `<a href="#/queue" onclick="window.HLM.UI.openDetail(${a.task_id});return false;" class="mono">#${a.task_id}</a>${a.task_status ? ` <span class="tag ${esc(a.task_status)}">${esc(a.task_status)}</span>` : ''}` : '-'}</td>
          <td class="nowrap">${statusTag(a.status)}${a.assignee_name ? `<div style="font-size:11px;color:var(--muted);">${esc(a.assignee_name)}</div>` : ''}</td>
          <td class="nowrap">${fmt(a.created_at)}</td>
          <td class="nowrap">${actionBtns(a)}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }

  function actionBtns(a) {
    if (a.status === 'resolved') return `<span style="color:var(--muted);font-size:12px;">${a.resolved_at ? fmt(a.resolved_at) : '-'}</span>`;
    let b = '';
    if (a.status === 'active') b += `<button class="btn sm" onclick="window.HLM.Alerts.ack(${a.id})">${Icons.check}${t('alerts.ack')}</button>`;
    if (window.HLM.can('alerts.manage')) {
      b += `<button class="btn sm danger" onclick="window.HLM.Alerts.resolve(${a.id})">${t('alerts.resolve')}</button>`;
    }
    return b;
  }

  async function ack(id) {
    try {
      await API.post(`/alerts/${id}/ack`, {});
      toast(t('alerts.acked'), 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  function resolve(id) {
    confirmDialog(t('alerts.resolve'), t('alerts.resolveConfirm'), async () => {
      try {
        await API.post(`/alerts/${id}/resolve`, {});
        toast(t('alerts.resolved'), 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function switchTab(next) {
    tab = next;
    page = 1;
    const bar = $('#alertTabs');
    if (bar) bar.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('primary', b.dataset.tab === tab));
    load();
  }

  function setPage(n) { page = Math.max(1, n); load(); }

  window.HLM.Alerts = { load, ack, resolve, switchTab, setPage, tab: () => tab };
})();
