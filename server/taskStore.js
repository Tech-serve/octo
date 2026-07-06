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
]) {
  try { db.exec(alter); } catch { /* колонка уже есть */ }
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
    dialog_id, step_order, depends_on, reply_to_text,
    error, created_at, scheduled_at, started_at, finished_at, logs)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const countSameStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM tasks WHERE profile_uuid = ? AND base_text = ?',
);

// Сколько постов с таким же базовым текстом уже есть у профиля (для лимита).
function countSameForProfile(profileUuid, baseText) {
  return countSameStmt.get(profileUuid, baseText).n;
}
const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE tasks SET status = ?, error = ?, started_at = ?, finished_at = ?, logs = ?, scheduled_at = ? WHERE id = ?
`);
const listStmt = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');

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
  insertStmt.run(
    id, STATUS.QUEUED, payload.profileUuid, payload.postUrl, payload.commentText,
    baseText, imagePath, dialogId, stepOrder, dependsOn, replyToText,
    null, createdAt, scheduledAt, null, null, '',
  );
  return {
    id,
    status: STATUS.QUEUED,
    payload: { ...payload, baseText, imagePath, replyToText },
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

function list() {
  return listStmt.all().map(rowToTask).map(toPublic);
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

module.exports = {
  STATUS, createTask, update, get, toPublic, list, loadPending, countSameForProfile, pruneOld,
};
