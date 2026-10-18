/* 毕业设计归档管理系统 — 前端逻辑 */
'use strict';

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const TOKEN = () => localStorage.getItem('bdag_token') || '';
let ME = null;
let pollTimer = null;
let adminState = { status: '', teacher: '', kw: '' };

/* ---------- 基础 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(p, opts = {}) {
  const res = await fetch('/api' + p, {
    method: opts.method || 'GET',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      TOKEN() ? { Authorization: 'Bearer ' + TOKEN() } : {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && p !== '/login') { doLogout(true); throw new Error(data.error || '请重新登录'); }
  if (!res.ok) throw new Error(data.error || '请求失败（' + res.status + '）');
  return data;
}
const badge = st => `<span class="badge" data-st="${esc(st)}">${esc(st)}</span>`;
const dt = s => (s ? String(s).slice(0, 16) : '');

function showModal(title, bodyHTML, onOk, okText = '确定', okClass = 'btn') {
  $modal.innerHTML = `
    <div class="modal-mask" id="mm">
      <div class="modal">
        <h3>${esc(title)}</h3>
        ${bodyHTML}
        <div class="actions">
          <button class="btn ghost" id="m-cancel">取消</button>
          <button class="btn ${okClass === 'btn danger' ? 'danger' : okClass === 'btn green' ? 'green' : ''}" id="m-ok">${esc(okText)}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('mm').onclick = e => { if (e.target.id === 'mm') closeModal(); };
  document.getElementById('m-ok').onclick = async () => {
    try { await onOk(); closeModal(); } catch (e) { alert(e.message); }
  };
}
function closeModal() { $modal.innerHTML = ''; }
function confirmModal(text, onOk, okText = '确定', okClass = 'btn') {
  showModal('请确认', `<p style="line-height:1.8">${text}</p>`, onOk, okText, okClass);
}

/* ---------- 登录 ---------- */
function renderLogin(msg = '') {
  stopPoll();
  $app.innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <h1>毕业设计归档管理系统</h1>
      <div class="sub">Excel 建档 · 逐份清点 · 归档留痕 · 数据永久保存于服务器</div>
      <div class="form-item">
        <label>登录身份</label>
        <select id="lg-role">
          <option value="admin">教务管理员</option>
          <option value="teacher">指导教师</option>
        </select>
      </div>
      <div class="form-item">
        <label>账号（教师请输入姓名，如：刘志强）</label>
        <input id="lg-user" autocomplete="username" placeholder="请输入账号">
      </div>
      <div class="form-item">
        <label>密码</label>
        <input id="lg-pass" type="password" autocomplete="current-password" placeholder="请输入密码">
      </div>
      ${msg ? `<p style="color:var(--red);font-size:13px;margin-bottom:10px">${esc(msg)}</p>` : ''}
      <button class="btn block" id="lg-btn">登 录</button>
      <div class="login-tip" style="color:#888;font-size:12px">
        教务管理员与教师账号由系统分配，请使用已授权的凭据登录
      </div>
    </div>
  </div>`;
  const doLogin = async () => {
    const role = document.getElementById('lg-role').value;
    const username = document.getElementById('lg-user').value.trim();
    const password = document.getElementById('lg-pass').value;
    if (!username || !password) return renderLoginMsg('请输入账号和密码');
    try {
      const r = await api('/login', { method: 'POST', body: { username, password, role } });
      localStorage.setItem('bdag_token', r.token);
      ME = r.user;
      enter();
    } catch (e) { renderLoginMsg(e.message); }
  };
  const renderLoginMsg = m => { const el = document.getElementById('lg-err'); if (el) el.textContent = m; else renderLogin(m); };
  document.getElementById('lg-btn').onclick = doLogin;
  $app.querySelectorAll('#lg-pass').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));
}

async function doLogout(silent) {
  try { if (!silent) await api('/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('bdag_token');
  ME = null;
  renderLogin();
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPoll(fn) { stopPoll(); pollTimer = setInterval(fn, 5000); }

function enter() {
  if (!ME) return;
  if (ME.role === 'admin') renderAdmin();
  else renderTeacher();
}

/* ---------- 顶部栏 ---------- */
function topbar(extra) {
  return `
  <div class="topbar">
    <span class="logo">毕业设计归档管理系统</span>
    <span class="role-badge">${ME.role === 'admin' ? '教务管理员' : '指导教师'}</span>
    ${extra || ''}
    <span class="spacer"></span>
    <span class="notif-bell">${''}</span>
    <span class="user">${esc(ME.username)}</span>
    <button class="btn ghost sm" id="btn-logout">退出登录</button>
  </div>`;
}
function bindLogout() { document.getElementById('btn-logout').onclick = () => doLogout(false); }

/* ---------- 通知中心 ---------- */
function notifTagClass(type) {
  if (type === '退回通知') return 'danger';
  if (type === '催办提醒' || type === '每日自动提醒') return 'warn';
  if (type === '完成通知' || type === '全部完成' || type === '归档完成') return 'green';
  return '';
}
function notifListHTML(list) {
  if (!list.length) return `<div class="empty-tip">暂无通知</div>`;
  return list.map(n => `
    <div class="notif">
      <span class="tag ${notifTagClass(n.type)}">${esc(n.type)}</span>
      <div class="msg">${esc(n.content)}<div class="time">${esc(n.created_at)}</div></div>
    </div>`).join('');
}
async function openNotifs() {
  const r = await api('/notifications');
  showModal('通知中心（含催办 / 提醒 / 完成通知）', `
    <div style="max-height:380px;overflow:auto;border:1px solid var(--border);border-radius:8px">
      ${notifListHTML(r.list)}
    </div>
    <p class="muted" style="font-size:12px;margin-top:8px">共 ${r.list.length} 条，未读 ${r.unread} 条。通知将永久保留在服务器中。</p>`,
    async () => { try { await api('/notifications/read', { method: 'POST' }); } catch {} }, '全部标为已读');
}

/* ================= 教务管理员端 ================= */
async function renderAdmin() {
  stopPoll();
  $app.innerHTML = `
    ${topbar(`<button class="btn ghost sm" id="btn-notifs">通知中心</button>`)}
    <div class="container" id="admin-body"><div class="card">加载中…</div></div>`;
  bindLogout();
  document.getElementById('btn-notifs').onclick = openNotifs;
  await refreshAdmin();
  startPoll(refreshAdmin);
}

async function refreshAdmin() {
  let s, recs;
  try {
    s = await api('/admin/summary');
    const params = new URLSearchParams();
    if (adminState.status) params.set('status', adminState.status);
    if (adminState.teacher) params.set('teacher', adminState.teacher);
    if (adminState.kw) params.set('q', adminState.kw);
    recs = await api('/admin/records' + (params.toString() ? '?' + params : ''));
  } catch (e) { return; }

  const c = s.counts;
  const body = document.getElementById('admin-body');
  if (!body) return;
  body.innerHTML = `
    ${s.allSubmitted ? `<div class="banner-done">本届全部归档提交完成，流程结束 ✓（共 ${s.total} 份）</div>` : ''}
    ${s.deadline ? `<div class="banner-warn">归档截止日：<b>${esc(s.deadline)}</b>。截止日前 7 天起，系统每日自动提醒未归档教师。</div>` : ''}

    <div class="card">
      <h2>总体情况 <span class="hint">首页实时刷新（每 5 秒）</span></h2>
      <div class="stats">
        <div class="stat c0"><div class="num">${s.total}</div><div class="lbl">毕设总份数</div></div>
        <div class="stat c1"><div class="num">${c['未提交']}</div><div class="lbl">未提交</div></div>
        <div class="stat c2"><div class="num">${c['已提交']}</div><div class="lbl">已提交（待清点）</div></div>
        <div class="stat c3"><div class="num">${c['已退回']}</div><div class="lbl">已退回（整改中）</div></div>
        <div class="stat c4"><div class="num">${c['已归档']}</div><div class="lbl">已归档</div></div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>上传 Excel 至系统 <span class="hint">解析 Excel 生成归档清单，逐份建档</span></h2>
        <div class="upload-row">
          <input type="file" id="xls-file" accept=".xlsx,.xls">
          <button class="btn ghost" id="btn-template">下载 Excel 模板</button>
        </div>
        <div class="import-result" id="import-result">
          <span class="muted" style="font-size:12px">选择 Excel 文件后将自动解析建档</span>
        </div>
        <div class="section-gap"></div>
        <h2>可选配置：归档截止日</h2>
        <div class="upload-row">
          <input type="date" id="deadline" value="${esc(s.deadline)}">
          <button class="btn" id="btn-deadline">保存截止日</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:6px">保存后，截止日前 7 天起系统每日自动提醒未归档教师。</p>
      </div>

      <div class="card">
        <h2>催办 <span class="hint">按首页未归名单一键催办（含学生、题目）</span></h2>
        <div class="upload-row">
          <button class="btn green" id="btn-remind">一键催办未归档教师（${s.total - c['已归档']} 份未归档）</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:6px">示例：刘老师，您所指导学生葛天白的毕设纸质文档《××××》尚未归档，请尽快办理！</p>
        <div class="section-gap"></div>
        <h2>教师账号（上传 Excel 自动创建）</h2>
        <table>
          <thead><tr><th>指导教师</th><th>名下份数</th><th>未归档</th></tr></thead>
          <tbody>
            ${s.teachers.length ? s.teachers.map(t => `
              <tr><td>${esc(t.teacher)}</td><td>${t.total}</td><td>${t.unarchived}</td></tr>`).join('')
              : `<tr><td colspan="3" class="empty-tip">暂无教师，请先上传 Excel</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>全部记录 · 逐份清点 <span class="hint">对「已提交」的份进行清点：合格 → 归档；不合格 → 退回</span></h2>
      <div class="filters">
        <select id="f-status">
          <option value="">全部状态</option>
          ${['未提交', '已提交', '已退回', '已归档'].map(x => `<option value="${x}" ${adminState.status === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
        <select id="f-teacher">
          <option value="">全部教师</option>
          ${s.teachers.map(t => `<option value="${esc(t.teacher)}" ${adminState.teacher === t.teacher ? 'selected' : ''}>${esc(t.teacher)}</option>`).join('')}
        </select>
        <input type="search" id="f-kw" placeholder="搜索学生 / 题目" value="${esc(adminState.kw)}">
      </div>
      <table>
        <thead><tr>
          <th>届</th><th>指导教师</th><th>学生</th><th class="td-title">毕设题目</th><th>状态</th><th>柜号 / 层格</th><th>归档时间 / 经办人</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${recs.list.length ? recs.list.map(r => `
            <tr>
              <td>${esc(r.batch)}</td>
              <td>${esc(r.teacher)}</td>
              <td>${esc(r.student)}</td>
              <td class="td-title">${esc(r.title)}${r.return_reason ? `<div class="reason" style="font-size:12px">退回原因：${esc(r.return_reason)}</div>` : ''}</td>
              <td>${badge(r.status)}</td>
              <td>${r.cabinet ? esc(r.cabinet) + ' / ' + esc(r.shelf) : '—'}</td>
              <td class="muted">${r.archived_at ? esc(dt(r.archived_at)) + '<br>经办人：' + esc(r.handler) : '—'}</td>
              <td>${r.status === '已提交' ? `
                <button class="btn green sm" data-arch="${r.id}" data-name="${esc(r.student)}">合格·归档</button>
                <button class="btn danger sm" data-rej="${r.id}" data-name="${esc(r.student)}">不合格·退回</button>` : '—'}
              </td>
            </tr>`).join('') : `<tr><td colspan="8" class="empty-tip">暂无记录</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>操作日志 <span class="hint">全部操作永久留痕，不可删除</span></h2>
      <div class="logs" id="logs-box"><div class="empty-tip">点击查看</div></div>
      <button class="btn ghost sm" id="btn-logs" style="margin-top:10px">加载操作日志</button>
    </div>`;

  /* ---- 事件绑定 ---- */
  const fileEl = document.getElementById('xls-file');
  fileEl.onchange = () => {
    if (fileEl.files && fileEl.files[0]) doImport(fileEl);
  };
  document.getElementById('btn-template').onclick = () => downloadTemplate();
  document.getElementById('btn-deadline').onclick = async () => {
    const d = document.getElementById('deadline').value;
    try {
      await api('/admin/deadline', { method: 'POST', body: { deadline: d } });
      alert(d ? `归档截止日已设置为 ${d}` : '归档截止日已清除');
      refreshAdmin();
    } catch (e) { alert(e.message); }
  };
  document.getElementById('btn-remind').onclick = () => confirmModal(
    `将按首页未归名单逐份发送催办通知（未归档 <b>${s.total - c['已归档']}</b> 份），通知内容含学生与题目。确定发送？`,
    async () => {
      const r = await api('/admin/remind-all', { method: 'POST' });
      alert(`已发送 ${r.sent} 条催办通知（未归档 ${r.unarchived} 份）`);
      refreshAdmin();
    }, '确认催办', 'btn green');

  document.getElementById('f-status').onchange = e => { adminState.status = e.target.value; refreshAdmin(); };
  document.getElementById('f-teacher').onchange = e => { adminState.teacher = e.target.value; refreshAdmin(); };
  let kwTimer = null;
  document.getElementById('f-kw').oninput = e => {
    clearTimeout(kwTimer);
    kwTimer = setTimeout(() => { adminState.kw = e.target.value.trim(); refreshAdmin(); }, 400);
  };
  body.querySelectorAll('[data-arch]').forEach(b => b.onclick = () => archiveModal(b.dataset.arch, b.dataset.name));
  body.querySelectorAll('[data-rej]').forEach(b => b.onclick = () => rejectModal(b.dataset.arch, b.dataset.name));
  document.getElementById('btn-logs').onclick = loadLogs;
}

async function loadLogs() {
  const r = await api('/admin/logs');
  const box = document.getElementById('logs-box');
  if (!box) return;
  box.innerHTML = r.list.length
    ? r.list.map(l => `<div class="log-row"><span class="t">${esc(l.time)}</span><span class="a">${esc(l.actor)}</span>${esc(l.action)}${l.detail ? ' — ' + esc(l.detail) : ''}</div>`).join('')
    : `<div class="empty-tip">暂无日志</div>`;
}

async function downloadTemplate() {
  try {
    const res = await fetch('/api/admin/template', {
      headers: TOKEN() ? { Authorization: 'Bearer ' + TOKEN() } : {},
    });
    if (!res.ok) throw new Error('下载失败（' + res.status + '）');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '归档清单模板.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}

async function doImport(fileEl) {
  const f = fileEl.files && fileEl.files[0];
  const box = document.getElementById('import-result');
  if (!f) { box.innerHTML = '<span class="err">请先选择 Excel 文件（.xlsx / .xls）</span>'; return; }
  box.innerHTML = `<span class="muted">⏳ 正在解析 <b>${esc(f.name)}</b> ...</span>`;
  try {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const r = await api('/admin/import', { method: 'POST', body: { rows, filename: f.name } });
    const resultHtml = `
      ✅ 解析完成：<b>${esc(f.name)}</b><br>
      新建归档 ${r.inserted} 份（${esc(r.batch)} 届），重复跳过 ${r.duplicated} 份，空行 ${r.empty} 行<br>
      ${r.newTeachers.length ? `涉及教师：${r.newTeachers.map(esc).join('、')}（新教师账号初始密码 123456）<br>` : ''}
      ${r.errors.length ? `<span class="err">错误 ${r.errors.length} 行：<br>${r.errors.map(e => esc(e.reason)).join('<br>')}</span>` : '无错误行'}`;
    await refreshAdmin();
    const box2 = document.getElementById('import-result');
    if (box2) box2.innerHTML = resultHtml;
  } catch (e) {
    box.innerHTML = `<span class="err">导入失败：${esc(e.message)}</span>`;
  }
}

function archiveModal(id, name) {
  showModal(`逐份确认归档 — ${esc(name)}（合格）`, `
    <p class="muted" style="margin-bottom:12px;font-size:13px">已当面清点：份数 / 签字 / 封面 / 装订 均合规。请录入归档位置与经办人：</p>
    <div class="form-item"><label>柜号（必填）</label><input id="ar-cabinet" placeholder="如：A-01"></div>
    <div class="form-item"><label>层格（必填）</label><input id="ar-shelf" placeholder="如：3层2格"></div>
    <div class="form-item"><label>经办人（默认当前管理员）</label><input id="ar-handler" value="${esc(ME.username)}"></div>`,
    async () => {
      await api('/admin/archive', {
        method: 'POST',
        body: { id: Number(id), cabinet: document.getElementById('ar-cabinet').value, shelf: document.getElementById('ar-shelf').value, handler: document.getElementById('ar-handler').value },
      });
      refreshAdmin();
    }, '确认归档', 'btn green');
}

function rejectModal(id, name) {
  showModal(`标记退回 — ${esc(name)}（不合格）`, `
    <p class="muted" style="margin-bottom:12px;font-size:13px">请填写不合格原因，教师将按原因整改后重新提交：</p>
    <textarea id="rj-reason" placeholder="如：签字页缺失 / 封面信息错误 / 装订不符合规范…"></textarea>`,
    async () => {
      await api('/admin/reject', { method: 'POST', body: { id: Number(id), reason: document.getElementById('rj-reason').value } });
      refreshAdmin();
    }, '确认退回', 'btn danger');
}

/* ================= 指导教师端 ================= */
async function renderTeacher() {
  stopPoll();
  $app.innerHTML = `
    ${topbar(`<button class="btn ghost sm" id="btn-notifs">通知中心</button>`)}
    <div class="container" id="teacher-body"><div class="card">加载中…</div></div>`;
  bindLogout();
  document.getElementById('btn-notifs').onclick = openNotifs;
  await refreshTeacher();
  startPoll(refreshTeacher);
}

async function refreshTeacher() {
  let s, r;
  try {
    s = await api('/teacher/summary');
    r = await api('/teacher/records');
  } catch (e) { return; }
  const c = s.counts;
  const body = document.getElementById('teacher-body');
  if (!body) return;
  body.innerHTML = `
    ${s.allSubmitted ? `<div class="banner-done">您名下本届毕设已全部提交，任务默认完成 ✓（共 ${s.total} 份）<div style="font-size:12px;font-weight:400;margin-top:6px">请等待教务清点归档；如被退回，请按退回原因整改后重新提交。</div></div>` : ''}
    ${s.deadline && !s.allSubmitted ? `<div class="banner-warn">归档截止日：<b>${esc(s.deadline)}</b>，请尽快向学生收齐纸质稿（签字 / 封面 / 装订合规）并在上班时段送至院办，随后在本页面确认提交。</div>` : ''}

    <div class="card">
      <h2>我的归档清单 <span class="hint">逐份显示学生 / 题目 / 状态，实时刷新</span></h2>
      <div class="stats" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat c0"><div class="num">${s.total}</div><div class="lbl">名下总份数</div></div>
        <div class="stat c1"><div class="num">${c['未提交']}</div><div class="lbl">未提交</div></div>
        <div class="stat c3"><div class="num">${c['已退回']}</div><div class="lbl">被退回（需整改）</div></div>
        <div class="stat c2"><div class="num">${c['已提交']}</div><div class="lbl">已提交（待清点）</div></div>
      </div>
      <div class="section-gap"></div>
      <table>
        <thead><tr>
          <th>学生</th><th class="td-title">毕设题目</th><th>状态</th><th>说明</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${r.list.length ? r.list.map(x => `
            <tr>
              <td>${esc(x.student)}</td>
              <td class="td-title">${esc(x.title)}</td>
              <td>${badge(x.status)}</td>
              <td>${x.status === '已退回' ? `<span class="reason">退回原因：${esc(x.return_reason)}</span>`
      : x.status === '已归档' ? `<span class="muted">已归档：柜号 ${esc(x.cabinet)} / 层格 ${esc(x.shelf)}</span>`
        : x.status === '已提交' ? `<span class="muted">已提交 ${esc(dt(x.submitted_at))}，待教务逐份清点</span>`
          : '<span class="muted">线下收齐纸质稿并送至院办后，点击右侧确认</span>'}</td>
              <td>${(x.status === '未提交' || x.status === '已退回') ? `
                <button class="btn sm ${x.status === '已退回' ? 'danger' : ''}" data-sub="${x.id}" data-name="${esc(x.student)}"
                  data-resub="${x.status === '已退回' ? 1 : 0}">${x.status === '已退回' ? '整改后重新提交' : '确认提交'}</button>` : '—'}
              </td>
            </tr>`).join('') : `<tr><td colspan="5" class="empty-tip">暂无归档清单，请等待教务上传 Excel 下发</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>最新通知 <span class="hint">催办 / 提醒 / 完成通知（点顶部「通知中心」查看全部）</span></h2>
      <div id="tn-box">${''}</div>
    </div>`;

  const nb = document.getElementById('tn-box');
  try {
    const n = await api('/notifications');
    nb.innerHTML = notifListHTML(n.list.slice(0, 8));
  } catch { nb.innerHTML = '<div class="empty-tip">通知加载失败</div>'; }

  body.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => {
    const resub = b.dataset.resub === '1';
    confirmModal(
      resub
        ? `确认已按退回原因完成整改，并将 <b>${esc(b.dataset.name)}</b> 的毕设纸质文档重新送至院办？提交后状态将更新为「已提交」。`
        : `确认已线下向学生收齐 <b>${esc(b.dataset.name)}</b> 的纸质稿（签字 / 封面 / 装订合规），并在上班时段送至院办？提交后状态将更新为「已提交」。`,
      async () => { await api('/teacher/submit', { method: 'POST', body: { id: Number(b.dataset.sub) } }); refreshTeacher(); },
      resub ? '确认重新提交' : '确认提交', resub ? 'btn danger' : 'btn green');
  });
}

/* ---------- 启动 ---------- */
(async function boot() {
  if (!TOKEN()) return renderLogin();
  try {
    const r = await api('/me');
    ME = r.user;
    enter();
  } catch { renderLogin(); }
})();
