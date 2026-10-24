/**
 * 毕业设计（纸质稿）归档管理系统 — 服务器端
 * 技术栈：Node.js 内置 http + node:sqlite（数据库永久存储）+ xlsx（Excel 解析/模板）
 *
 * 角色与流程（严格对应流程图）：
 *  教务管理员：上传 Excel 建档 → 设置截止日 → 一键催办 → 逐份清点 → 合格归档(柜号/层格/归档时间/经办人) / 不合格退回
 *  系统自动  ：解析 Excel 逐份建档、下发清单通知、截止日前 7 天每日提醒未归档教师、状态实时刷新、教师/本届完成判定
 *  指导教师  ：查看我的归档清单 → 线下收齐纸质稿送院办后线上确认提交 → 收退回原因整改后重新提交
 *  数据永久保存于 data/archive.db，系统不提供任何删除入口，操作全程留痕（logs 表）。
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------------- 工具函数 ---------------- */
const pad = n => String(n).padStart(2, '0');
const now = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const today = () => now().slice(0, 10);
const teacherLabel = t => (t && t.endsWith('老师') ? t : `${t}老师`);
const smsText = (t, s, title) => `${teacherLabel(t)}，您所指导学生${s}的毕设纸质文档《${title}》尚未归档，请尽快办理！`;
const smsTextDay = (t, dl) => `${teacherLabel(t)}，您所指导学生的毕设纸质文档尚未归档，归档截止日为 ${dl}，请尽快办理！`;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makeUser(username, password, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { username, salt, pass_hash: hashPassword(password, salt), role };
}

/* ---------------- 云端备份配置（数据库自动备份至 GitHub 私有仓库，数据永久保存） ---------------- */
const GH_TOKEN = process.env.GH_TOKEN || '';   // GitHub 细粒度 Token（仅需备份仓库的 Contents 读写权限）
const GH_REPO = process.env.GH_REPO || '';     // 备份仓库，格式：owner/repo
const DB_FILE = path.join(DATA_DIR, 'archive.db');

/* 数据库打开前：若本地数据库缺失（如平台重新部署后磁盘清空），先从云端恢复最新备份 */
function restoreFromCloud() {
  if (!GH_TOKEN || !GH_REPO || fs.existsSync(DB_FILE)) return '';
  try {
    execSync(
      `curl -sfL --max-time 90 -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/${GH_REPO}/contents/archive.db" -o "${DB_FILE}"`,
      { stdio: 'ignore' }
    );
    return fs.existsSync(DB_FILE) ? `已从云端恢复数据库（${fs.statSync(DB_FILE).size} 字节）` : '云端暂无备份，使用全新数据库';
  } catch { return '云端恢复失败，使用全新数据库'; }
}
const RESTORE_MSG = restoreFromCloud();

/* ---------------- 数据库（永久存储） ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher')),
  must_change_pass INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS copies(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT NOT NULL,
  teacher TEXT NOT NULL,
  student TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '未提交',
  return_reason TEXT,
  cabinet TEXT, shelf TEXT, handler TEXT,
  submitted_at TEXT, archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_copies_status ON copies(status);
CREATE INDEX IF NOT EXISTS idx_copies_teacher ON copies(teacher);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
`);

/* 数据库结构升级：users 增加 must_change_pass（首次登录须改密） */
{
  const cols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
  if (!cols.includes('must_change_pass')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_pass INTEGER NOT NULL DEFAULT 0');
  }
  // 历史教师账号若仍使用初始密码 123456，则要求首次登录修改
  const legacy = db.prepare("SELECT id, salt FROM users WHERE role='teacher' AND must_change_pass=0").all();
  const setFlag = db.prepare('UPDATE users SET must_change_pass=1 WHERE id=?');
  for (const u of legacy) {
    if (hashPassword('123456', u.salt) === db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id).pass_hash) setFlag.run(u.id);
  }
}

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users(username, pass_hash, salt, role, must_change_pass, created_at) VALUES (?,?,?,?,?,?)'),
  updatePassword: db.prepare('UPDATE users SET pass_hash=?, salt=?, must_change_pass=0 WHERE id=?'),
  insertSession: db.prepare('INSERT INTO sessions(token, user_id, created_at) VALUES (?,?,?)'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  insertCopy: db.prepare('INSERT INTO copies(batch, teacher, student, title, status, created_at) VALUES (?,?,?,?,?,?)'),
  findCopy: db.prepare('SELECT * FROM copies WHERE batch=? AND teacher=? AND student=? AND title=?'),
  insertNotif: db.prepare('INSERT INTO notifications(user_id, type, content, created_at) VALUES (?,?,?,?)'),
  notifsOf: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200'),
  notifUnread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0'),
  notifReadAll: db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?'),
  insertLog: db.prepare('INSERT INTO logs(time, actor, action, detail) VALUES (?,?,?,?)'),
  logsAll: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 300'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  copiesOfTeacher: db.prepare('SELECT * FROM copies WHERE teacher = ? ORDER BY id'),
  copyById: db.prepare('SELECT * FROM copies WHERE id = ?'),
  updateCopyStatus: db.prepare('UPDATE copies SET status=?, return_reason=NULL, submitted_at=? WHERE id=?'),
  updateCopyReturn: db.prepare('UPDATE copies SET status=?, return_reason=? WHERE id=?'),
  updateCopyArchive: db.prepare('UPDATE copies SET status=?, cabinet=?, shelf=?, handler=?, archived_at=? WHERE id=?'),
  deleteCopy: db.prepare('DELETE FROM copies WHERE id=?'),
  copyUnarchived: db.prepare("SELECT * FROM copies WHERE status != '已归档' ORDER BY teacher, id"),
  batchUnsubmitted: db.prepare("SELECT COUNT(*) c FROM copies WHERE status IN ('未提交','已退回')"),
  batchTotal: db.prepare('SELECT COUNT(*) c FROM copies'),
  batchCounts: db.prepare("SELECT status, COUNT(*) c FROM copies GROUP BY status"),
  teacherStats: db.prepare("SELECT teacher, COUNT(*) total, SUM(CASE WHEN status!='已归档' THEN 1 ELSE 0 END) unarchived FROM copies GROUP BY teacher ORDER BY teacher"),
  teachersList: db.prepare("SELECT * FROM users WHERE role='teacher' ORDER BY username"),
  allCopies: db.prepare('SELECT * FROM copies ORDER BY id DESC LIMIT 2000'),
  batchAllSubmittedFlag: db.prepare("SELECT value FROM settings WHERE key='batch_all_submitted'"),
};

function log(actor, action, detail) { q.insertLog.run(now(), actor, action, detail || ''); }
if (RESTORE_MSG) log('系统', '云端备份', RESTORE_MSG);

/* 云端备份：数据有变化后自动把数据库文件备份到 GitHub 私有仓库（每 60 秒检查一次） */
let lastBackupM = 0;
function dataMtime() {
  let m = 0;
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch {}
  }
  return m;
}
async function backupToCloud(manual) {
  if (!GH_TOKEN || !GH_REPO) return;
  try {
    if (!manual && dataMtime() <= lastBackupM + 1) return; // 无变化，跳过
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');           // 先把 WAL 合并进主库文件再备份
    const buf = fs.readFileSync(DB_FILE);
    const head = { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'grad-archive-system', 'Content-Type': 'application/json' };
    const meta = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/archive.db`, { headers: head, signal: AbortSignal.timeout(30000) }).then(r => r.ok ? r.json() : null).catch(() => null);
    const put = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/archive.db`, {
      method: 'PUT', headers: head, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ message: `数据库自动备份 ${now()}`, content: buf.toString('base64'), ...(meta && meta.sha ? { sha: meta.sha } : {}) })
    });
    if (put.ok) {
      lastBackupM = dataMtime();
      log('系统', '云端备份', `数据库已备份至 GitHub 仓库（${buf.length} 字节）`);
    } else {
      console.error(`[${now()}] 云端备份失败: HTTP ${put.status}`);
    }
  } catch (e) { console.error(`[${now()}] 云端备份异常:`, e.message); }
}
if (GH_TOKEN && GH_REPO) {
  setInterval(backupToCloud, 60 * 1000);
  process.on('SIGTERM', () => { backupToCloud(true).finally(() => process.exit(0)); }); // 平台停止实例前先做一次最终备份
}
function notify(userId, type, content) { q.insertNotif.run(userId, type, content, now()); }
function getSetting(key) { const r = q.getSetting.get(key); return r ? r.value : null; }
function setSetting(key, value) { q.setSetting.run(key, String(value)); }

/* 初始化管理员账号（仅首次） */
if (q.userByName.get('admin') == null) {
  const u = makeUser('admin', 'admin123', 'admin');
  q.insertUser.run(u.username, u.pass_hash, u.salt, u.role, 0, now());
  log('系统', '初始化', '创建默认教务管理员账号 admin（密码 admin123）');
}

/* ---------------- HTTP 基础 ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJSONBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}
function auth(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const sess = q.sessionByToken.get(m[1]);
  if (!sess) return null;
  const u = q.userById.get(sess.user_id);
  return u ? { id: u.id, username: u.username, role: u.role, must_change_pass: !!u.must_change_pass } : null;
}

/* ---------------- 业务：Excel 导入（解析 Excel 生成归档清单，逐份建档） ---------------- */
const COL_TEACHER = ['指导教师', '教师', '指导老师', 'teacher'];
const COL_STUDENT = ['学生姓名', '学生', '姓名', 'student'];
const COL_TITLE = ['毕设题目', '题目', '论文题目', '毕业设计题目', 'title'];
function pick(row, keys) {
  for (const k of Object.keys(row)) {
    const kk = String(k).trim().toLowerCase();
    if (keys.some(x => x.toLowerCase() === kk)) {
      const v = row[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}

async function handleImport(req, res, user) {
  const body = await readJSONBody(req);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const filename = String(body.filename || 'Excel 导入');
  const batch = String(body.batch || new Date().getFullYear());
  if (!rows.length) return sendJSON(res, 400, { error: '未解析到任何数据行，请确认 Excel 内容' });

  const errors = []; let inserted = 0; let duplicated = 0; let empty = 0;
  const newTeachers = new Map(); // teacher -> [students]
  for (let i = 0; i < rows.length; i++) {
    const t = pick(rows[i] || {}, COL_TEACHER);
    const s = pick(rows[i] || {}, COL_STUDENT);
    const ti = pick(rows[i] || {}, COL_TITLE);
    if (!t && !s && !ti) { empty++; continue; }
    if (!t || !s || !ti) {
      const miss = [!t && '指导教师', !s && '学生姓名', !ti && '毕设题目'].filter(Boolean).join('、');
      errors.push({ row: i + 2, reason: `第 ${i + 2} 行缺少：${miss}` });
      continue;
    }
    if (q.findCopy.get(batch, t, s, ti)) { duplicated++; continue; }
    q.insertCopy.run(batch, t, s, ti, '未提交', now());
    inserted++;
    if (!newTeachers.has(t)) newTeachers.set(t, []);
    newTeachers.get(t).push(`${s}《${ti}》`);
    if (!q.userByName.get(t)) {
      const u = makeUser(t, '123456', 'teacher');
      q.insertUser.run(u.username, u.pass_hash, u.salt, u.role, 1, now());
      log('系统', '创建教师账号', `${t}（初始密码 123456）`);
    }
  }
  // 推送通知：下发我的归档清单
  for (const [t, list] of newTeachers) {
    const tu = q.userByName.get(t);
    if (!tu) continue;
    const head = list.slice(0, 30).join('、');
    const more = list.length > 30 ? `…等共 ${list.length} 份` : `共 ${list.length} 份`;
    notify(tu.id, '清单下发', `您的归档清单已下发（${batch} 届）：${head}${list.length > 30 ? more : `，共 ${list.length} 份`}。请及时查收并按清单办理归档。`);
  }
  if (inserted > 0) {
    // 新数据进入后，重置“本届全部提交完成”的一次性通知标记
    if (getSetting('batch_all_submitted') === '1') setSetting('batch_all_submitted', '0');
  }
  log(user.username, '上传 Excel 至系统', `文件：${filename}；${batch} 届新建 ${inserted} 份，重复跳过 ${duplicated} 份，空行 ${empty} 行，错误行 ${errors.length}`);
  sendJSON(res, 200, { inserted, duplicated, empty, errors, batch, newTeachers: [...newTeachers.keys()] });
}

/* ---------------- 业务：清点（合格归档 / 不合格退回） ---------------- */
async function handleArchive(req, res, user) {
  const { id, cabinet, shelf, handler } = await readJSONBody(req);
  const c = q.copyById.get(Number(id));
  if (!c) return sendJSON(res, 404, { error: '记录不存在' });
  if (c.status !== '已提交') return sendJSON(res, 400, { error: `该份当前状态为「${c.status}」，仅「已提交」的份可进行清点归档` });
  const cb = String(cabinet || '').trim(); const sf = String(shelf || '').trim(); const hd = String(handler || '').trim() || user.username;
  if (!cb || !sf) return sendJSON(res, 400, { error: '请填写柜号与层格' });
  q.updateCopyArchive.run('已归档', cb, sf, hd, now(), c.id);
  const tu = q.userByName.get(c.teacher);
  if (tu) notify(tu.id, '归档完成', `您指导的学生${c.student}的毕设纸质文档已完成归档（柜号 ${cb}，层格 ${sf}），感谢配合。`);
  log(user.username, '逐份确认归档', `学生 ${c.student}《${c.title}》→ 柜号 ${cb} / 层格 ${sf} / 经办人 ${hd}`);
  sendJSON(res, 200, { ok: true });
}

async function handleReject(req, res, user) {
  const { id, reason } = await readJSONBody(req);
  const c = q.copyById.get(Number(id));
  if (!c) return sendJSON(res, 404, { error: '记录不存在' });
  if (c.status !== '已提交') return sendJSON(res, 400, { error: `该份当前状态为「${c.status}」，仅「已提交」的份可退回` });
  const r = String(reason || '').trim();
  if (!r) return sendJSON(res, 400, { error: '请填写不合格原因' });
  q.updateCopyReturn.run('已退回', r, c.id);
  const tu = q.userByName.get(c.teacher);
  if (tu) notify(tu.id, '退回通知', `您指导的学生${c.student}的毕设纸质文档清点不合格，已被退回。原因：${r}。请按退回原因整改后重新送交院办并在线上重新提交。`);
  log(user.username, '标记退回', `学生 ${c.student}《${c.title}》；不合格原因：${r}`);
  sendJSON(res, 200, { ok: true });
}

/* ---------------- 业务：教师提交（该份状态更新为已提交） ---------------- */
async function handleSubmit(req, res, user) {
  const { id } = await readJSONBody(req);
  const c = q.copyById.get(Number(id));
  if (!c) return sendJSON(res, 404, { error: '记录不存在' });
  if (user.role !== 'teacher' || c.teacher !== user.username) return sendJSON(res, 403, { error: '只能提交自己名下的毕设' });
  if (c.status !== '未提交' && c.status !== '已退回') return sendJSON(res, 400, { error: `该份当前状态为「${c.status}」，无需重复提交` });
  const isResubmit = c.status === '已退回';
  q.updateCopyStatus.run('已提交', now(), c.id);
  log(user.username, isResubmit ? '整改后重新提交' : '确认提交（已送院办）', `学生 ${c.student}《${c.title}》状态：${c.status} → 已提交`);

  // 判定：该教师名下是否全部已提交
  const mine = q.copiesOfTeacher.all(user.username);
  const stillOpen = mine.some(x => x.status === '未提交' || x.status === '已退回');
  if (!stillOpen && mine.length > 0) {
    notify(user.id, '完成通知', '恭喜！您名下本届全部毕设纸质文档均已提交，任务默认完成。请等待教务清点归档，如被退回请按原因整改后重新提交。');
    log('系统', '教师任务默认完成', `${user.username} 名下 ${mine.length} 份全部已提交，已发送完成通知`);
    const au = q.userByName.get('admin');
    if (au) notify(au.id, '完成通知', `教师 ${user.username} 名下 ${mine.length} 份毕设已全部提交，可进行逐份清点。`);
    // 判定：本届是否全部已提交
    const un = q.batchUnsubmitted.get().c; const total = q.batchTotal.get().c;
    const done = getSetting('batch_all_submitted');
    if (un === 0 && total > 0 && done !== '1') {
      setSetting('batch_all_submitted', '1');
      log('系统', '本届全部已提交', `本届 ${total} 份毕设全部提交完成，流程结束`);
      if (au) notify(au.id, '全部完成', `本届 ${total} 份毕设全部提交完成，流程结束！可在首页查看归档情况。`);
    }
  }
  sendJSON(res, 200, { ok: true });
}

/* ---------------- 业务：催办 ---------------- */
async function handleRemindAll(req, res, user) {
  const unarchived = q.copyUnarchived.all();
  if (!unarchived.length) return sendJSON(res, 400, { error: '当前没有未归档的记录，无需催办' });
  let sent = 0;
  for (const c of unarchived) {
    const tu = q.userByName.get(c.teacher);
    if (!tu) continue;
    notify(tu.id, '催办提醒', smsText(c.teacher, c.student, c.title));
    sent++;
  }
  log(user.username, '按首页未归名单一键催办', `发送催办通知 ${sent} 条（未归档 ${unarchived.length} 份）`);
  sendJSON(res, 200, { ok: true, sent, unarchived: unarchived.length });
}

/* ---------------- 业务：截止日前 7 天每日自动提醒 ---------------- */
function dailyReminderCheck() {
  const dl = getSetting('deadline');
  if (!dl) return;
  const diff = Math.round((new Date(dl + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
  if (diff < 0 || diff > 7) return;                 // 仅在截止日前 7 天起（含截止日当天）
  const key = 'daily_reminder_' + today();
  if (getSetting(key)) return;                      // 每日仅一次
  setSetting(key, now());
  const unarchived = q.copyUnarchived.all();
  const byTeacher = new Map();
  for (const c of unarchived) {
    if (!byTeacher.has(c.teacher)) byTeacher.set(c.teacher, []);
    byTeacher.get(c.teacher).push(c);
  }
  let sent = 0;
  for (const [t, list] of byTeacher) {
    const tu = q.userByName.get(t);
    if (!tu) continue;
    const first = smsText(t, list[0].student, list[0].title);
    const content = list.length > 1
      ? `${first}（另有 ${list.length - 1} 份尚未归档，详见我的归档清单）`
      : first;
    notify(tu.id, '每日自动提醒', content);
    sent++;
  }
  if (sent > 0) log('系统', '每日自动提醒', `截止日 ${dl} 前自动提醒未归档教师，发送 ${sent} 条`);
}

/* ---------------- 业务：查询接口 ---------------- */
function adminSummary() {
  const counts = { '未提交': 0, '已提交': 0, '已退回': 0, '已归档': 0 };
  for (const r of q.batchCounts.all()) if (r.status in counts) counts[r.status] = r.c;
  const total = q.batchTotal.get().c;
  return {
    total,
    counts,
    deadline: getSetting('deadline') || '',
    allSubmitted: total > 0 && counts['未提交'] === 0 && counts['已退回'] === 0,
    teachers: q.teacherStats.all(),
    unread: q.notifUnread.get(1).c,
  };
}
function recordsView(list) {
  return list.map(c => ({
    id: c.id, batch: c.batch, teacher: c.teacher, student: c.student, title: c.title,
    status: c.status, return_reason: c.return_reason || '', cabinet: c.cabinet || '', shelf: c.shelf || '',
    handler: c.handler || '', submitted_at: c.submitted_at || '', archived_at: c.archived_at || '', created_at: c.created_at,
  }));
}

/* ---------------- 路由 ---------------- */
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('POST', '/api/login', async (req, res) => {
  const { username, password, role } = await readJSONBody(req);
  const u = q.userByName.get(String(username || '').trim());
  if (!u) return sendJSON(res, 401, { error: '账号不存在' });
  if (hashPassword(String(password || ''), u.salt) !== u.pass_hash) return sendJSON(res, 401, { error: '密码错误' });
  if (role && role !== u.role) return sendJSON(res, 403, { error: u.role === 'admin' ? '该账号为教务管理员，请选择教务管理员登录' : '该账号为指导教师，请选择指导教师登录' });
  const token = crypto.randomBytes(24).toString('hex');
  q.insertSession.run(token, u.id, now());
  log(u.username, '登录系统', `角色：${u.role === 'admin' ? '教务管理员' : '指导教师'}`);
  sendJSON(res, 200, { token, user: { id: u.id, username: u.username, role: u.role, must_change_pass: !!u.must_change_pass } });
});

/* 修改密码（首次登录强制改密也走此接口） */
route('POST', '/api/change-password', async (req, res, user) => {
  const body = await readJSONBody(req);
  const oldPass = String(body.oldPassword || '');
  const newPass = String(body.newPassword || '');
  const u = q.userById.get(user.id);
  if (!u) return sendJSON(res, 401, { error: '账号不存在' });
  if (hashPassword(oldPass, u.salt) !== u.pass_hash) return sendJSON(res, 400, { error: '原密码不正确' });
  if (newPass.length < 6) return sendJSON(res, 400, { error: '新密码至少 6 位' });
  if (newPass === '123456') return sendJSON(res, 400, { error: '新密码不能使用初始密码 123456' });
  if (newPass === oldPass) return sendJSON(res, 400, { error: '新密码不能与原密码相同' });
  const salt = crypto.randomBytes(16).toString('hex');
  q.updatePassword.run(hashPassword(newPass, salt), salt, u.id);
  log(u.username, '修改密码', '首次登录/主动修改密码成功');
  sendJSON(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res, user) => {
  sendJSON(res, 200, { user });
});

route('POST', '/api/logout', async (req, res) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) q.deleteSession.run(m[1]);
  sendJSON(res, 200, { ok: true });
});

route('GET', '/api/notifications', async (req, res, user) => {
  sendJSON(res, 200, { list: q.notifsOf.all(user.id), unread: q.notifUnread.get(user.id).c });
});
route('POST', '/api/notifications/read', async (req, res, user) => {
  q.notifReadAll.run(user.id);
  sendJSON(res, 200, { ok: true });
});

/* —— 教务管理员 —— */
route('GET', '/api/admin/summary', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  sendJSON(res, 200, adminSummary());
});
route('POST', '/api/admin/deadline', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  const { deadline } = await readJSONBody(req);
  const d = String(deadline || '').trim();
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return sendJSON(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
  setSetting('deadline', d);
  if (d) { setSetting('deadline_notified', '0'); log(user.username, '设置归档截止日', d); }
  else log(user.username, '清除归档截止日', '');
  sendJSON(res, 200, { ok: true, deadline: d });
});
route('POST', '/api/admin/import', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  await handleImport(req, res, user);
});
route('POST', '/api/admin/remind-all', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  await handleRemindAll(req, res, user);
});
route('GET', '/api/admin/records', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  const url = new URL(req.url, 'http://x');
  let list = q.allCopies.all();
  const status = url.searchParams.get('status') || '';
  const teacher = url.searchParams.get('teacher') || '';
  const kw = (url.searchParams.get('q') || '').trim();
  if (status) list = list.filter(c => c.status === status);
  if (teacher) list = list.filter(c => c.teacher === teacher);
  if (kw) list = list.filter(c => c.student.includes(kw) || c.title.includes(kw) || c.teacher.includes(kw));
  sendJSON(res, 200, { list: recordsView(list) });
});
route('POST', '/api/admin/archive', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  await handleArchive(req, res, user);
});
route('POST', '/api/admin/reject', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  await handleReject(req, res, user);
});
route('POST', '/api/admin/delete', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  const body = await readJSONBody(req);
  const id = Number(body.id);
  const c = q.copyById.get(id);
  if (!c) return sendJSON(res, 404, { error: '记录不存在' });
  q.deleteCopy.run(id);
  log(user.username, '删除记录', `${c.batch}届 ${c.teacher} 指导 ${c.student}《${c.title}》（原状态：${c.status}）`);
  sendJSON(res, 200, { ok: true });
});
route('GET', '/api/admin/logs', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  sendJSON(res, 200, { list: q.logsAll.all() });
});
route('GET', '/api/admin/template', async (req, res, user) => {
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅教务管理员可访问' });
  const aoa = [
    ['指导教师', '学生姓名', '毕设题目'],
    ['刘志强', '葛天白', '宁杭城际铁路枢纽客流组织优化研究'],
    ['王芳', '陈晓东', '基于深度学习的校园垃圾分类识别系统'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '归档清单');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('归档清单模板.xlsx')}`,
  });
  res.end(buf);
});

/* —— 指导教师 —— */
route('GET', '/api/teacher/summary', async (req, res, user) => {
  if (user.role !== 'teacher') return sendJSON(res, 403, { error: '仅指导教师可访问' });
  const mine = q.copiesOfTeacher.all(user.username);
  const counts = { '未提交': 0, '已提交': 0, '已退回': 0, '已归档': 0 };
  for (const c of mine) if (c.status in counts) counts[c.status]++;
  sendJSON(res, 200, {
    total: mine.length, counts,
    allSubmitted: mine.length > 0 && counts['未提交'] === 0 && counts['已退回'] === 0,
    deadline: getSetting('deadline') || '',
    unread: q.notifUnread.get(user.id).c,
  });
});
route('GET', '/api/teacher/records', async (req, res, user) => {
  if (user.role !== 'teacher') return sendJSON(res, 403, { error: '仅指导教师可访问' });
  sendJSON(res, 200, { list: recordsView(q.copiesOfTeacher.all(user.username)) });
});
route('POST', '/api/teacher/submit', async (req, res, user) => {
  if (user.role !== 'teacher') return sendJSON(res, 403, { error: '仅指导教师可访问' });
  await handleSubmit(req, res, user);
});

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(PUBLIC_DIR, p);
  if (p.startsWith('/vendor/')) {
    const name = p.replace('/vendor/', '');
    file = path.join(ROOT, 'node_modules', 'xlsx', 'dist', name);
  }
  if (!file.startsWith(PUBLIC_DIR) && !file.startsWith(path.join(ROOT, 'node_modules'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname === '/api/health') return sendJSON(res, 200, { ok: true, time: now() }); // 健康检查（保活探测用）
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    for (const r of routes) {
      if (r.method === req.method && r.pattern === pathname) {
        if (r.pattern !== '/api/login') {
          const user = auth(req);
          if (!user) return sendJSON(res, 401, { error: '未登录或登录已过期，请重新登录' });
          // 首次登录未改密时，仅允许改密/查询自身/退出
          const open = ['/api/change-password', '/api/me', '/api/logout'];
          if (user.must_change_pass && !open.includes(pathname)) {
            return sendJSON(res, 403, { error: '首次登录需先修改密码', code: 'MUST_CHANGE_PASSWORD' });
          }
          await r.handler(req, res, user);
        } else {
          await r.handler(req, res);
        }
        return;
      }
    }
    sendJSON(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error(`[${now()}]`, req.method, pathname, e.message);
    if (!res.headersSent) sendJSON(res, 500, { error: e.message || '服务器内部错误' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${now()}] 毕业设计归档管理系统已启动: http://localhost:${PORT}  (数据永久保存于 data/archive.db)`);
});

/* 每日自动提醒：启动时检查一次，之后每 30 分钟检查一次 */
dailyReminderCheck();
setInterval(dailyReminderCheck, 30 * 60 * 1000);
