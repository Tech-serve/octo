const config = require('./config');
const store = require('./taskStore');
const { createTaskLogger, logger } = require('./logger');
const {
  leaveFacebookComment, hideForeignComments, collectPages, scoutWatchedPosts,
} = require('./fbWorker');
const { disconnectOcto } = require('./octoService');

// Ручки бегущих задач (для жёсткой отмены): taskId -> { canceled, browser, profileUuid }.
const running = new Map();

// Очередь с ограничением параллелизма + двумя правилами:
//  1) задача не стартует раньше task.scheduledAt (разбивка по времени);
//  2) задачи ОДНОГО профиля не выполняются одновременно (один профиль = один
//     браузер Octo) — параллелятся только разные профили.
const pending = [];
let active = 0;
// Из них — фоновые задачи авто-чистки (тип 'hidebg'). Они низкоприоритетны и
// им достаётся не больше половины СВОБОДНЫХ слотов (вторая половина — буфер под
// постинг). Ручная чистка (тип 'hide') сюда НЕ входит — она идёт как обычная.
let activeBg = 0;
const runningProfiles = new Set();
let ticker = null;

// Сколько фоновых чисток можно держать одновременно ПРЯМО СЕЙЧАС: половина
// слотов, не занятых постингом/обычными задачами (посты всегда в приоритете).
function bgAllowedNow() {
  const nonBg = active - activeBg; // занятые постингом/обычными задачами
  return Math.floor((config.maxConcurrent - nonBg) / 2);
}

// Скользящее среднее реальной длительности задачи (учимся на фактах).
let avgDurationMs = 90000; // стартовая оценка до первых замеров
let durationSamples = 0;

function recordDuration(taskId) {
  const t = store.get(taskId);
  if (!t || !t.startedAt || !t.finishedAt) return;
  const dur = new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime();
  if (!(dur > 0) || dur > 30 * 60000) return; // отсечь мусорные значения
  avgDurationMs = durationSamples === 0
    ? dur
    : Math.round((avgDurationMs * durationSamples + dur) / (durationSamples + 1));
  durationSamples = Math.min(durationSamples + 1, 50); // ограничиваем инерцию среднего
}

function getAvgDurationMs() {
  return avgDurationMs;
}

// Когда (абсолютное время, мс) освободится профиль по цепочке его задач.
// Учитываем сериализацию: задачи одного профиля идут строго по очереди.
function chainFreeAt(taskList, nowTs) {
  const sorted = taskList.slice().sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
  let cursor = nowTs;
  for (const t of sorted) {
    const start = (t.status === 'running' && t.startedAt)
      ? new Date(t.startedAt).getTime()
      : Math.max(cursor, t.scheduledAt || nowTs);
    let finish = start + avgDurationMs;
    if (t.status === 'running' && finish < nowTs + 8000) finish = nowTs + 8000;
    cursor = Math.max(finish, cursor);
  }
  return cursor;
}

// Абсолютное время освобождения конкретного профиля (или now, если свободен).
const isActive = (t) => t.status !== 'done' && t.status !== 'error' && t.status !== 'canceled';

function profileFreeAt(profileUuid, nowTs = Date.now()) {
  const list = store.list().filter((t) => t.profileUuid === profileUuid && isActive(t));
  return chainFreeAt(list, nowTs);
}

// УМНОЕ РАЗМЕЩЕНИЕ: самое раннее время ≥ desiredStart (и ≥ now), где до любой
// уже существующей задачи этого фейка сохраняется зазор ≥ [MIN_FAKE_GAP]. Так
// новая задача заполняет простой ПЕРЕД будущей запланированной, а не ждёт её.
function earliestSlot(profileUuid, desiredStart, nowTs = Date.now()) {
  const gMin = config.minFakeGapMinMs;
  const gMax = Math.max(config.minFakeGapMaxMs, gMin);
  const G = gMin + Math.random() * (gMax - gMin);

  const starts = store.list()
    .filter((t) => t.profileUuid === profileUuid && isActive(t))
    .map((t) => ((t.status === 'running' && t.startedAt)
      ? new Date(t.startedAt).getTime()
      : (t.scheduledAt || nowTs)))
    .sort((a, b) => a - b);

  let t = Math.max(desiredStart, nowTs);
  for (const s of starts) {
    if (s + G <= t) continue; // существующая задача достаточно раньше — не мешает
    if (t + G <= s) break; // до неё хватает окна — ставим здесь
    t = s + G; // слишком близко — сдвигаем сразу после неё (с зазором)
  }
  return Math.round(t);
}

// Занятость по всем профилям: { uuid: { freeInMs, startInMs } }.
//  freeInMs  — через сколько профиль освободится (конец цепочки задач);
//  startInMs — через сколько НАЧНЁТСЯ ближайшая задача (0 если уже идёт/пора).
// Возвращаем остатки (а не абсолют), чтобы не зависеть от часов клиента.
function busyRemaining(nowTs = Date.now()) {
  const active = store.list().filter(isActive);
  const byProfile = {};
  for (const t of active) {
    (byProfile[t.profileUuid] = byProfile[t.profileUuid] || []).push(t);
  }
  const out = {};
  for (const uuid of Object.keys(byProfile)) {
    const list = byProfile[uuid];
    const free = chainFreeAt(list, nowTs);
    if (free <= nowTs) continue;

    // Ближайший старт: у бегущей — реальный старт, у остальных — scheduledAt.
    let start = Infinity;
    for (const t of list) {
      const s = (t.status === 'running' && t.startedAt)
        ? new Date(t.startedAt).getTime()
        : (t.scheduledAt || nowTs);
      if (s < start) start = s;
    }
    out[uuid] = {
      freeInMs: free - nowTs,
      startInMs: Math.max(0, start - nowTs),
    };
  }
  return out;
}

// Таймер, чтобы отложенные (scheduledAt в будущем) задачи стартовали вовремя,
// даже если не приходит новых событий.
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(drain, 10000);
  if (ticker.unref) ticker.unref();
}

function enqueue(task) {
  pending.push(task);
  logger.info(`Задача ${task.id} добавлена в очередь (в очереди: ${pending.length}, активно: ${active})`, 'queue');
  ensureTicker();
  drain();
}

function drain() {
  const now = Date.now();
  let started = true;
  while (active < config.maxConcurrent && started) {
    started = false;
    let bgPick = -1; // первый готовый к запуску фоновый (низкий приоритет)
    for (let i = 0; i < pending.length; i++) {
      const task = pending[i];

      // Зависимость (режим 3): реплика ждёт завершения предыдущего шага.
      if (task.dependsOn) {
        const dep = store.get(task.dependsOn);
        const depStatus = dep ? dep.status : 'error';
        if (depStatus === store.STATUS.ERROR || depStatus === store.STATUS.CANCELED) {
          // Предыдущий шаг не удался/отменён — вся ветка обрывается.
          pending.splice(i, 1);
          store.update(task.id, {
            status: store.STATUS.CANCELED,
            finishedAt: new Date().toISOString(),
          });
          started = true;
          break;
        }
        if (depStatus !== store.STATUS.DONE) continue; // ещё не готов — ждём
      }

      if ((task.scheduledAt || 0) > now) continue; // ещё не время
      if (runningProfiles.has(task.payload.profileUuid)) continue; // профиль занят

      // Фон наблюдения (скаут + авто-чистка) придерживаем: запускаем только когда
      // обычных задач (постинг/деревья/ручная чистка) на запуск не осталось.
      if (task.payload.type === 'hidebg' || task.payload.type === 'scout') {
        if (bgPick === -1) bgPick = i;
        continue;
      }

      pending.splice(i, 1);
      runTask(task);
      started = true;
      break; // пересчитываем условия цикла заново
    }
    if (started) continue; // обрыв ветки или запуск обычной — пересчитать заново

    // Обычных к запуску нет — берём фоновую чистку, если её квота не исчерпана
    // (не более половины свободных слотов; вторая половина — буфер под постинг).
    if (bgPick >= 0 && activeBg < bgAllowedNow()) {
      const task = pending.splice(bgPick, 1)[0];
      runTask(task);
      started = true;
    }
  }
}

// Транзиентная ли ошибка (стоит повторить). НЕ повторяем «не подтверждён» (коммент
// мог реально запоститься → дубль) и таймаут задачи. Повторяем обрывы сессии,
// навигацию и неудачи открытия reply-бокса/поиска коммента (они не запостили).
function isRetryable(msg) {
  if (!msg) return false;
  if (/не подтверждён|придержал/i.test(msg)) return false;
  if (/превысила лимит/i.test(msg)) return false;
  return /closed|target page|context or browser|econnreset|socket hang up|timeout \d+ms exceeded|page\.goto|err_|не найден комментарий для ответа|не открылось поле ответа|не найдена кнопка|не открылся|не загрузил|already started|octo отказал|ws_endpoint/i.test(msg);
}

async function runTask(task) {
  active++;
  const isBg = task.payload.type === 'hidebg' || task.payload.type === 'scout';
  if (isBg) activeBg += 1;
  runningProfiles.add(task.payload.profileUuid);
  const handle = { canceled: false, browser: null, profileUuid: task.payload.profileUuid };
  running.set(task.id, handle);
  const taskLog = createTaskLogger(task.id);

  store.update(task.id, {
    status: store.STATUS.RUNNING,
    startedAt: new Date().toISOString(),
  });
  taskLog.info(`Старт задачи. Профиль=${task.payload.profileUuid}, пост=${task.payload.postUrl}`);

  // Жёсткий предохранитель от зависаний: если задача идёт дольше лимита — рвём её
  // (гасим браузер, чтобы in-flight await'ы упали), помечаем ошибкой и освобождаем
  // слот очереди, чтобы следующие фейки не стояли.
  let killTimer = null;
  const timeoutP = new Promise((_, reject) => {
    killTimer = setTimeout(() => {
      taskLog.warn(`Задача превысила лимит ${Math.round(config.taskTimeoutMs / 1000)}с — прерываю (зависла).`);
      try { if (handle.browser) handle.browser.close().catch(() => {}); } catch { /* ignore */ }
      reject(new Error(`Задача превысила лимит ${Math.round(config.taskTimeoutMs / 1000)}с — прервана (зависла). Проверьте вручную.`));
    }, config.taskTimeoutMs);
    if (killTimer.unref) killTimer.unref();
  });

  try {
    let identity = null;
    let lastErr = null;
    const maxAttempts = 1 + Math.max(0, config.taskRetries);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        let worker = leaveFacebookComment;
        if (task.payload.type === 'hide' || task.payload.type === 'hidebg') worker = hideForeignComments;
        else if (task.payload.type === 'pages') worker = collectPages;
        else if (task.payload.type === 'scout') worker = scoutWatchedPosts;
        const work = worker(task.payload, taskLog, handle);
        work.catch(() => {}); // проглотить, если таймаут выиграл гонку
        // eslint-disable-next-line no-await-in-loop
        identity = await Promise.race([work, timeoutP]);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // Не ретраим: отмена, бан/чекпоинт, «не подтверждён» (мог запоститься),
        // таймаут задачи — только транзиентные (обрыв/навигация/reply-setup).
        if (handle.canceled || err.accountStatus || !isRetryable(err.message)) break;
        if (attempt < maxAttempts) {
          taskLog.warn(`Попытка ${attempt}/${maxAttempts} не удалась: ${err.message}. Повтор...`);
          handle.browser = null;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 2500 + Math.round(Math.random() * 2500)));
        }
      }
    }
    if (lastErr) throw lastErr;

    // Обновляем белый список реальной FB-идентичностью фейка (id + имя из сессии).
    if (identity && (identity.fbId || identity.fbName)) {
      try { store.upsertWhitelist(task.payload.profileUuid, identity.fbId, identity.fbName); } catch { /* ignore */ }
    }
    // Успешный коммент = аккаунт жив: снимаем возможную старую пометку ⚠️.
    try { store.clearProfileFlag(task.payload.profileUuid); } catch { /* ignore */ }
    store.update(task.id, {
      status: store.STATUS.DONE,
      finishedAt: new Date().toISOString(),
      logs: taskLog.getLines(),
    });
    taskLog.info('Задача завершена успешно');
  } catch (err) {
    if (handle.canceled) {
      store.update(task.id, {
        status: store.STATUS.CANCELED,
        finishedAt: new Date().toISOString(),
        logs: taskLog.getLines(),
      });
      taskLog.info('Задача отменена пользователем');
    } else {
      store.update(task.id, {
        status: store.STATUS.ERROR,
        error: err.message,
        finishedAt: new Date().toISOString(),
        logs: taskLog.getLines(),
      });
      taskLog.error(`Задача завершилась с ошибкой: ${err.message}`);
      // Помечаем фейк с ТОЧНЫМ статусом: если воркер определил (бан/проверка/…) —
      // берём его, иначе по тексту ошибки считаем checkpoint.
      let st = err.accountStatus
        || (/checkpoint|проверк|заблокир|verif/i.test(err.message) ? 'checkpoint' : null);
      // Дохлый прокси у фейка → ⚠️ прокси (снимется при успешном комменте).
      if (!st && /err_socks|err_proxy|err_tunnel|proxy data/i.test(err.message)) st = 'proxy';
      if (st) {
        try { store.flagProfile(task.payload.profileUuid, st); } catch { /* ignore */ }
      }
    }
  } finally {
    if (killTimer) clearTimeout(killTimer);
    store.update(task.id, { logs: taskLog.getLines() });
    taskLog.close();
    if (!handle.canceled) recordDuration(task.id); // отменённые не портят среднее
    // Фоновая авто-чистка — отметим результат в записи наблюдения (для UI-статуса).
    if (task.payload.type === 'hidebg') {
      try { require('./watchScheduler').onCleanFinished(task); } catch { /* ignore */ }
    }
    running.delete(task.id);
    active--;
    if (isBg) activeBg -= 1;
    runningProfiles.delete(task.payload.profileUuid);
    drain();
  }
}

// Отмена задачи. Если ещё в очереди — просто убираем. Если УЖЕ ВЫПОЛНЯЕТСЯ —
// гасим её браузер и Octo-сессию: in-flight операции упадут, воркер размотается
// и пометит задачу canceled.
function cancel(id) {
  const idx = pending.findIndex((t) => t.id === id);
  if (idx >= 0) {
    pending.splice(idx, 1);
    store.update(id, { status: store.STATUS.CANCELED, finishedAt: new Date().toISOString() });
    return 'canceled';
  }

  const handle = running.get(id);
  if (handle) {
    handle.canceled = true;
    // Закрыть браузерную сессию (прервёт текущие действия воркера).
    try { if (handle.browser) handle.browser.close().catch(() => {}); } catch { /* ignore */ }
    // Остановить профиль Octo сразу, не дожидаясь finally воркера.
    try { disconnectOcto(handle.profileUuid, logger); } catch { /* ignore */ }
    // Оптимистично помечаем отменённой (воркер подтвердит в своём finally).
    store.update(id, { status: store.STATUS.CANCELED, finishedAt: new Date().toISOString() });
    return 'canceled';
  }
  return 'notfound';
}

function stats() {
  return {
    active,
    activeBg,
    queued: pending.length,
    maxConcurrent: config.maxConcurrent,
    runningProfiles: runningProfiles.size,
  };
}

module.exports = {
  enqueue, stats, cancel, getAvgDurationMs, profileFreeAt, earliestSlot, busyRemaining,
};
