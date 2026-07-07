const config = require('./config');
const store = require('./taskStore');
const { logger } = require('./logger');
const {
  connectToOcto, disconnectOcto, readFbIdentity, detectAccountStatus,
} = require('./octoService');

const FB_URL = 'https://www.facebook.com/';

// Состояние единственного фонового пересбора белого списка (одновременно один).
//  alive   — аккаунтов «живых» (status ok);
//  flagged — с проблемой (checkpoint/бан/разлогин), помечены ⚠️;
//  failed  — не удалось открыть/прочитать (ошибка Octo/сети).
const state = {
  running: false,
  canceled: false,
  total: 0,
  done: 0,
  alive: 0,
  flagged: 0,
  failed: 0,
  current: '',
  startedAt: null,
  finishedAt: null,
  lastError: '',
};

function status() {
  return { ...state };
}

// Открыть один профиль, зайти на FB, прочитать identity + статус аккаунта,
// записать в whitelist и обновить пометку ⚠️. Возвращает { status }.
async function captureOne(uuid) {
  let connection;
  try {
    connection = await connectToOcto(uuid, logger);
    const { page } = connection;
    await page.goto(FB_URL, { waitUntil: 'domcontentloaded', timeout: config.navTimeout });
    await page.waitForTimeout(1500); // дать FB отрисовать inline-данные

    const ident = await readFbIdentity(page, { deep: true });
    if (ident.fbId || ident.fbName) store.upsertWhitelist(uuid, ident.fbId, ident.fbName);

    let acc = await detectAccountStatus(page);
    // Нет сессии (нет c_user) и явного блока не видно — считаем разлогином.
    if (acc === 'ok' && !ident.fbId) acc = 'logout';

    if (acc === 'ok') store.clearProfileFlag(uuid);
    else store.flagProfile(uuid, acc);

    return { status: acc };
  } finally {
    // Закрываем только СВОЮ сессию. Если connectToOcto упал («already started» —
    // в профиле кто-то работает), connection нет — профиль не трогаем.
    if (connection) {
      try { if (connection.browser) await connection.browser.close().catch(() => {}); } catch { /* ignore */ }
      try { await disconnectOcto(uuid, logger); } catch { /* ignore */ }
    }
  }
}

async function runPool(uuids, concurrency) {
  let idx = 0;
  const next = async () => {
    while (idx < uuids.length && !state.canceled) {
      const uuid = uuids[idx];
      idx += 1;
      state.current = uuid;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await captureOne(uuid);
        if (r.status === 'ok') state.alive += 1; else state.flagged += 1;
      } catch (e) {
        state.failed += 1;
        state.lastError = e.message;
        logger.warn(`[whitelist] ${uuid}: ${e.message}`, 'whitelist');
      } finally {
        state.done += 1;
      }
    }
  };
  const workers = [];
  for (let i = 0; i < concurrency; i += 1) workers.push(next());
  await Promise.all(workers);
}

// Запустить фоновый пересбор по списку uuid. Возвращает сразу.
function rebuild(uuids, opts = {}) {
  if (state.running) return { started: false, reason: 'already-running' };
  const list = Array.from(new Set((uuids || []).filter(Boolean)));
  if (!list.length) return { started: false, reason: 'empty' };

  Object.assign(state, {
    running: true, canceled: false, total: list.length, done: 0, alive: 0, flagged: 0, failed: 0,
    current: '', startedAt: new Date().toISOString(), finishedAt: null, lastError: '',
  });
  // По умолчанию — как основная очередь (MAX_CONCURRENT). Сбор легче коммента,
  // так что тянем столько же параллельно. Выше лимита машины не поднимаем.
  const concurrency = Math.max(1, Math.min(opts.concurrency || config.maxConcurrent, config.maxConcurrent));
  logger.info(`[whitelist] Старт пересбора: ${list.length} профилей, параллельно ${concurrency}`, 'whitelist');

  runPool(list, concurrency)
    .catch((e) => { state.lastError = e.message; })
    .finally(() => {
      state.running = false;
      state.current = '';
      state.finishedAt = new Date().toISOString();
      logger.info(`[whitelist] Пересбор завершён: живых=${state.alive}, проблемных=${state.flagged}, ошибок=${state.failed} из ${state.total}`, 'whitelist');
    });

  return { started: true, total: list.length };
}

function cancel() {
  if (!state.running) return false;
  state.canceled = true;
  return true;
}

module.exports = { rebuild, cancel, status };
