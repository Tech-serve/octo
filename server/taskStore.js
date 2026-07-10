const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Статусы: queued -> running -> done | error | canceled
const STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  CANCELED: 'canceled',
};

// Локальная БД (node:sqlite). Файл переживает рестарт сервера.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
// Ждать до 5с при блокировке файла — на случай, когда разовый скрипт проверки
// профилей пишет в ту же БД, что и запущенный сервер.
db.exec('PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    profile_uuid TEXT NOT NULL,
    post_url     TEXT NOT NULL,
    comment_text TEXT NOT NULL,
    error        TEXT,
    created_at   TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    started_at   TEXT,
    finished_at  TEXT,
    logs         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_profile ON tasks(profile_uuid);
`);

// Миграция: добавить новые колонки к уже существующей БД (без ошибки, если есть).
for (const alter of [
  'ALTER TABLE tasks ADD COLUMN base_text TEXT',   // исходный текст (для лимита одинаковых)
  'ALTER TABLE tasks ADD COLUMN image_path TEXT',  // путь к прикреплённой картинке
  'ALTER TABLE tasks ADD COLUMN dialog_id TEXT',   // режим 3: id диалога
  'ALTER TABLE tasks ADD COLUMN step_order INTEGER', // режим 3: порядок реплики
  'ALTER TABLE tasks ADD COLUMN depends_on TEXT',  // режим 3: id задачи-предшественника
  'ALTER TABLE tasks ADD COLUMN reply_to_text TEXT', // режим 3: текст коммента, на который отвечаем
  "ALTER TABLE tasks ADD COLUMN owner TEXT DEFAULT 'local'", // владелец задачи (user.id баера)
]) {
  try { db.exec(alter); } catch { /* колонка уже есть */ }
}

// Пометки фейков, требующих ручного вмешательства (checkpoint FB и т.п.).
// Общие для всех баеров — фейки это общий пул.
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_flags (
    profile_uuid TEXT PRIMARY KEY,
    reason       TEXT,
    flagged_at   TEXT NOT NULL
  );
`);

// Белый список фейков: реальные FB-идентичности, захваченные из самой FB-сессии
// (id из куки c_user, имя из CurrentUserInitialData). id — для точного матчинга
// в модерации, имя — для показа в селекте. Обновляется при каждом использовании
// фейка и разовым пересбором. Общий для всех баеров (фейки — общий пул).
db.exec(`
  CREATE TABLE IF NOT EXISTS fb_whitelist (
    profile_uuid TEXT PRIMARY KEY,
    fb_id        TEXT,
    fb_name      TEXT,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_whitelist_fbid ON fb_whitelist(fb_id);
`);

// Черновики операций (надёжное серверное хранение вместо localStorage): структура
// вкладок и поля каждой операции. Ключ — owner + key ('tabs' | 'op:<mode>:<id>').
// data — JSON. Картинки хранятся ФАЙЛАМИ (в data только их URL).
db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    owner      TEXT NOT NULL,
    key        TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, key)
  );
`);

const draftsGetAllStmt = db.prepare('SELECT key, data FROM drafts WHERE owner = ?');
const draftPutStmt = db.prepare(
  'INSERT INTO drafts (owner, key, data, updated_at) VALUES (?, ?, ?, ?) '
  + 'ON CONFLICT(owner, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
);
const draftDeleteStmt = db.prepare('DELETE FROM drafts WHERE owner = ? AND key = ?');

function getDrafts(owner) {
  const items = {};
  for (const row of draftsGetAllStmt.all(owner || 'local')) {
    try { items[row.key] = JSON.parse(row.data); } catch { /* пропустим битый */ }
  }
  return items;
}

function putDraft(owner, key, data) {
  draftPutStmt.run(owner || 'local', String(key), JSON.stringify(data ?? null), new Date().toISOString());
}

function deleteDraft(owner, key) {
  draftDeleteStmt.run(owner || 'local', String(key));
}

// Имена файлов из /uploads, на которые ссылается ЛЮБОЙ черновик (поля/результаты).
// Их нельзя удалять автоочисткой, иначе картинки пропадают из истории/логов.
const draftsAllDataStmt = db.prepare('SELECT data FROM drafts');
function referencedUploadFiles() {
  const set = new Set();
  const re = /\/uploads\/([\w.-]+\.(?:png|jpe?g|webp|gif))/gi;
  for (const row of draftsAllDataStmt.all()) {
    const s = row.data || '';
    let m = re.exec(s);
    while (m) { set.add(m[1]); m = re.exec(s); }
  }
  return set;
}

// Строку БД -> объект задачи привычной формы (с payload).
function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    payload: {
      profileUuid: r.profile_uuid,
      postUrl: r.post_url,
      commentText: r.comment_text,
      baseText: r.base_text || r.comment_text,
      imagePath: r.image_path || null,
      replyToText: r.reply_to_text || null,
    },
    owner: r.owner || 'local',
    dependsOn: r.depends_on || null,
    dialogId: r.dialog_id || null,
    stepOrder: r.step_order != null ? r.step_order : null,
    error: r.error || null,
    createdAt: r.created_at,
    scheduledAt: r.scheduled_at,
    startedAt: r.started_at || null,
    finishedAt: r.finished_at || null,
    logs: r.logs ? r.logs.split('\n') : [],
  };
}

const insertStmt = db.prepare(`
  INSERT INTO tasks (id, status, profile_uuid, post_url, comment_text, base_text, image_path,
    dialog_id, step_order, depends_on, reply_to_text, owner,
    error, created_at, scheduled_at, started_at, finished_at, logs)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const countSameStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM tasks WHERE profile_uuid = ? AND base_text = ? AND status = 'done'",
);

// Сколько ОПУБЛИКОВАННЫХ (status=done) постов с таким же базовым текстом уже есть
// у профиля — для лимита. Упавшие/отменённые не считаем: они не опубликовались.
function countSameForProfile(profileUuid, baseText) {
  return countSameStmt.get(profileUuid, baseText).n;
}
const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE tasks SET status = ?, error = ?, started_at = ?, finished_at = ?, logs = ?, scheduled_at = ? WHERE id = ?
`);
const listStmt = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');
const listByOwnerStmt = db.prepare('SELECT * FROM tasks WHERE owner = ? ORDER BY created_at DESC');
const listByDialogStmt = db.prepare('SELECT * FROM tasks WHERE dialog_id = ? ORDER BY step_order ASC');
const deleteByIdStmt = db.prepare('DELETE FROM tasks WHERE id = ?');

// Все шаги диалога по порядку (для «Продолжить»).
function listByDialog(dialogId) {
  return listByDialogStmt.all(dialogId).map(rowToTask);
}
// Удалить задачу по id (старые упавшие/отменённые шаги при возобновлении).
function deleteTask(id) {
  deleteByIdStmt.run(id);
}

function createTask(payload, opts = {}) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const scheduledAt = opts.scheduledAt || Date.now();
  const baseText = payload.baseText || payload.commentText;
  const imagePath = payload.imagePath || null;
  const dialogId = opts.dialogId || null;
  const stepOrder = opts.stepOrder != null ? opts.stepOrder : null;
  const dependsOn = opts.dependsOn || null;
  const replyToText = payload.replyToText || null;
  const owner = opts.owner || 'local';
  insertStmt.run(
    id, STATUS.QUEUED, payload.profileUuid, payload.postUrl, payload.commentText,
    baseText, imagePath, dialogId, stepOrder, dependsOn, replyToText, owner,
    null, createdAt, scheduledAt, null, null, '',
  );
  return {
    id,
    status: STATUS.QUEUED,
    payload: { ...payload, baseText, imagePath, replyToText },
    owner,
    dependsOn,
    dialogId,
    stepOrder,
    error: null,
    createdAt,
    scheduledAt,
    startedAt: null,
    finishedAt: null,
    logs: [],
  };
}

function update(id, patch) {
  const cur = getStmt.get(id);
  if (!cur) return null;
  const status = patch.status !== undefined ? patch.status : cur.status;
  const error = patch.error !== undefined ? patch.error : cur.error;
  const startedAt = patch.startedAt !== undefined ? patch.startedAt : cur.started_at;
  const finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : cur.finished_at;
  const scheduledAt = patch.scheduledAt !== undefined ? patch.scheduledAt : cur.scheduled_at;
  const logs = patch.logs !== undefined
    ? (Array.isArray(patch.logs) ? patch.logs.join('\n') : patch.logs)
    : cur.logs;
  updateStmt.run(status, error, startedAt, finishedAt, logs, scheduledAt, id);
  return get(id);
}

function get(id) {
  return rowToTask(getStmt.get(id));
}

// Публичное представление для фронта.
function toPublic(task) {
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    error: task.error,
    createdAt: task.createdAt,
    scheduledAt: task.scheduledAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    postUrl: task.payload.postUrl,
    profileUuid: task.payload.profileUuid,
    commentText: task.payload.commentText,
    imageUrl: task.payload.imagePath ? `/uploads/${path.basename(task.payload.imagePath)}` : null,
    dependsOn: task.dependsOn || null,
    dialogId: task.dialogId || null,
    stepOrder: task.stepOrder != null ? task.stepOrder : null,
    logs: task.logs,
  };
}

// Список задач. Если передан owner — только его задачи (для баера в кабинете).
function list(owner) {
  const rows = owner ? listByOwnerStmt.all(owner) : listStmt.all();
  return rows.map(rowToTask).map(toPublic);
}

// При старте сервера: незавершённые 'running' (прервались рестартом) вернуть в
// очередь, и отдать все 'queued' полными объектами для повторной постановки.
function loadPending() {
  db.prepare("UPDATE tasks SET status = 'queued' WHERE status = 'running'").run();
  return db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY scheduled_at ASC")
    .all()
    .map(rowToTask);
}

// Удалить задачи старше N дней. Возвращает список путей к их картинкам,
// чтобы вызывающий удалил файлы.
function pruneOld(days = 30) {
  const cutoffIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = db.prepare('SELECT image_path FROM tasks WHERE created_at < ?').all(cutoffIso);
  db.prepare('DELETE FROM tasks WHERE created_at < ?').run(cutoffIso);
  return rows.map((r) => r.image_path).filter(Boolean);
}

const flagInsertStmt = db.prepare(
  'INSERT OR REPLACE INTO profile_flags (profile_uuid, reason, flagged_at) VALUES (?, ?, ?)',
);
const flagDeleteStmt = db.prepare('DELETE FROM profile_flags WHERE profile_uuid = ?');
const flagListStmt = db.prepare('SELECT * FROM profile_flags');

// Пометить фейк как требующий вмешательства (напр. checkpoint).
function flagProfile(uuid, reason) {
  if (!uuid) return;
  flagInsertStmt.run(uuid, reason || 'checkpoint', new Date().toISOString());
}
// Снять пометку (баер подтвердил, что аккаунт проверен).
function clearProfileFlag(uuid) {
  flagDeleteStmt.run(uuid);
}
// { uuid: { reason, flaggedAt } } — все текущие пометки.
function listFlags() {
  const out = {};
  for (const r of flagListStmt.all()) {
    out[r.profile_uuid] = { reason: r.reason, flaggedAt: r.flagged_at };
  }
  return out;
}

const wlUpsertStmt = db.prepare(`
  INSERT INTO fb_whitelist (profile_uuid, fb_id, fb_name, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(profile_uuid) DO UPDATE SET
    fb_id = excluded.fb_id,
    fb_name = excluded.fb_name,
    updated_at = excluded.updated_at
`);
const wlListStmt = db.prepare('SELECT * FROM fb_whitelist');

// Записать/обновить FB-идентичность фейка. Пустые значения не затирают уже
// сохранённые (напр. имя не считалось — оставляем прежнее).
function upsertWhitelist(uuid, fbId, fbName) {
  if (!uuid || (!fbId && !fbName)) return;
  const cur = getWhitelist(uuid);
  const id = fbId || (cur && cur.fbId) || '';
  const name = fbName || (cur && cur.fbName) || '';
  wlUpsertStmt.run(uuid, id, name, new Date().toISOString());
}
const wlGetStmt = db.prepare('SELECT * FROM fb_whitelist WHERE profile_uuid = ?');
function getWhitelist(uuid) {
  const r = wlGetStmt.get(uuid);
  return r ? { fbId: r.fb_id || '', fbName: r.fb_name || '', updatedAt: r.updated_at } : null;
}
// { uuid: { fbId, fbName, updatedAt } } — весь белый список.
function listWhitelist() {
  const out = {};
  for (const r of wlListStmt.all()) {
    out[r.profile_uuid] = { fbId: r.fb_id || '', fbName: r.fb_name || '', updatedAt: r.updated_at };
  }
  return out;
}

module.exports = {
  STATUS, createTask, update, get, toPublic, list, loadPending, countSameForProfile, pruneOld,
  flagProfile, clearProfileFlag, listFlags,
  upsertWhitelist, getWhitelist, listWhitelist,
  listByDialog, deleteTask,
  getDrafts, putDraft, deleteDraft, referencedUploadFiles,
};
