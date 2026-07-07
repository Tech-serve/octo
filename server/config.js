const fs = require('fs');
const path = require('path');

// Минимальный парсер .env без внешних зависимостей.
// Значения из реального окружения (process.env) имеют приоритет над файлом.
function loadEnvFile() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // снять обрамляющие кавычки
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

function bool(v, def) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === 'true';
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function num(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

const config = {
  port: int(process.env.PORT, 3000),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  octoApi: process.env.OCTO_API || 'http://127.0.0.1:58888/api/profiles',
  octoCloudApi: process.env.OCTO_CLOUD_API || 'https://app.octobrowser.net/api/v2/automation',
  octoApiToken: process.env.OCTO_API_TOKEN || '',
  maxConcurrent: Math.max(1, int(process.env.MAX_CONCURRENT, 1)),
  logDir: process.env.LOG_DIR || 'logs',
  // Файл локальной БД (node:sqlite). Хранит задачи и переживает рестарт.
  dbPath: process.env.DB_PATH || path.resolve(__dirname, 'data', 'tasks.db'),
  // Папка для картинок, прикрепляемых к комментариям.
  uploadDir: process.env.UPLOAD_DIR || path.resolve(__dirname, 'data', 'uploads'),
  // Лимит одинаковых постов (по базовому тексту) на один профиль.
  maxSamePerProfile: int(process.env.MAX_SAME_PER_PROFILE, 10),
  headless: bool(process.env.HEADLESS, false),
  navTimeout: int(process.env.NAV_TIMEOUT, 60000),
  selectorTimeout: int(process.env.SELECTOR_TIMEOUT, 15000),
  // Таймаут подключения Playwright к уже запущенному профилю по CDP. Дефолт
  // Playwright — 30с; под нагрузкой много профилей не успевают, поэтому терпимее.
  cdpConnectTimeoutMs: int(process.env.CDP_CONNECT_TIMEOUT, 60000),
  // Блокировать загрузку ТОЛЬКО видео (картинки грузятся). Экономит RAM/CPU/трафик
  // на 10 параллельных профилях. Отключить: BLOCK_VIDEO=false.
  blockVideo: bool(process.env.BLOCK_VIDEO, true),
  // Пауза (в минутах) между постами ОДНОГО профиля: случайно в [min, max].
  // Первый пост профиля идёт сразу, каждый следующий — через случайную паузу.
  postDelayMinMs: Math.max(0, num(process.env.POST_DELAY_MIN, 1)) * 60000,
  postDelayMaxMs: Math.max(0, num(process.env.POST_DELAY_MAX, 2)) * 60000,
  // Режим 2 (один пост -> много фейков): случайный разброс времени старта
  // каждого фейка в окне [MODE2_MIN, MODE2_SPREAD] минут (то же для старта диалогов реж.3).
  // Первый фейк — сразу; каждый следующий — не раньше MODE2_MIN (чтобы не стартовали
  // все одновременно) и не позже MODE2_SPREAD.
  mode2SpreadMs: Math.max(1, num(process.env.MODE2_SPREAD, 3)) * 60000,
  mode2MinMs: Math.max(0, num(process.env.MODE2_MIN, 0.5)) * 60000,
  // Режим 3 (диалоги): пауза между репликами одного диалога, минуты.
  mode3GapMinMs: Math.max(0, num(process.env.MODE3_GAP_MIN, 1)) * 60000,
  mode3GapMaxMs: Math.max(0, num(process.env.MODE3_GAP_MAX, 5)) * 60000,
  // Минимальный зазор между задачами ОДНОГО фейка (умное заполнение окон):
  // новая задача встаёт в самое раннее окно, где до соседних задач ≥ этого.
  minFakeGapMinMs: Math.max(0, num(process.env.MIN_FAKE_GAP_MIN, 1)) * 60000,
  minFakeGapMaxMs: Math.max(0, num(process.env.MIN_FAKE_GAP_MAX, 3)) * 60000,

  // Авторизация. Выключена (standalone) — работает как раньше, без входа,
  // владелец задач = 'local'. Включена (встроен в таск-менеджер) — приходит
  // SSO-токен от ТМ, дальше бот держит свою сессионную куку.
  authEnabled: bool(process.env.AUTH_ENABLED, false),
  // Общий секрет с таск-менеджером (тот же GENERATOR_SSO_SECRET). Им бот
  // проверяет входящий SSO-токен.
  ssoSecret: process.env.GENERATOR_SSO_SECRET || '',
  ssoAudience: process.env.SSO_AUDIENCE || 'generator',
  ssoIssuer: process.env.SSO_ISSUER || 'taskmanager',
  // Свой секрет для сессионной куки бота (НЕ равен ssoSecret).
  sessionSecret: process.env.SESSION_JWT_SECRET || '',
  // Домен куки (напр. .vroo.it.com — чтобы кука жила и в iframe).
  cookieDomain: process.env.COOKIE_DOMAIN || '',
  // secure + SameSite=None нужны для cross-origin iframe (только по HTTPS).
  // Локально по http держим false, иначе браузер не примет куку.
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  // Разрешённый источник для встраивания в iframe (домен таск-менеджера).
  frameAncestor: process.env.FRAME_ANCESTOR || '',
  // Роли, которым разрешён вход в бота. Временно head/admin; чтобы вернуть
  // баеров — поставить BOT_ALLOWED_ROLES=buyer,admin в .env.
  botAllowedRoles: (process.env.BOT_ALLOWED_ROLES || 'head,admin')
    .split(',').map((s) => s.trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(Boolean),
};

module.exports = config;
