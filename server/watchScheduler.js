const store = require('./taskStore');
const queue = require('./queue');
const { logger } = require('./logger');

// Планировщик наблюдения. По каденции постов из списка запускает ОДНОГО скаута —
// дешёвый профиль-читатель (боевой фейк по кругу), который только смотрит, есть ли
// новые чужие комменты, и будит чистку (тип 'hidebg') под нужной страницей-админом.
// Приоритет и потолок «половина свободных слотов» держит очередь; скаут и чистки —
// фоновые. Снятие поста с наблюдения — тумблером (enabled=0).

let timer = null;
const health = { available: true, lastError: null, lastPickAt: null, lastScout: null };

// Разброс каденции ±15%, чтобы проверки не шли строго по часам (человечнее).
function withJitter(baseMs) {
  return baseMs * (0.85 + Math.random() * 0.3);
}

// Выбрать скаута: наименее-недавно-использованный, но ЖИВОЙ (есть в вайт-листе,
// не помечен проблемным) боевой фейк, который сейчас НЕ занят (нет задач в
// очереди/работе — иначе профиль нельзя запустить дважды и не воруем постинг).
function pickScout(busy) {
  const wl = store.listWhitelist();
  const flags = store.listFlags();
  const lastUsed = store.lastUsedByProfile();
  let best = null;
  let bestT = Infinity;
  for (const uuid of Object.keys(wl)) {
    if (flags[uuid]) continue; // не живой (checkpoint/бан/прокси)
    if (busy.has(uuid)) continue; // занят задачей — не берём
    const t = lastUsed[uuid] || 0; // давно не запускался = меньше t = приоритетнее
    if (t < bestT) { best = uuid; bestT = t; }
  }
  return best;
}

function tick() {
  let posts;
  try {
    posts = store.listEnabledWatch();
  } catch (e) {
    logger.error(`[watch] Не смог прочитать список наблюдения: ${e.message}`, 'watch');
    return;
  }
  if (!posts.length) return;

  const now = Date.now();
  const due = posts.filter((p) => {
    const lastCheck = p.lastCheckAt ? new Date(p.lastCheckAt).getTime() : 0;
    return now - lastCheck >= withJitter(p.periodMs);
  });
  if (!due.length) return;

  // Один скаут зараз: если задача-скаут уже в очереди/бежит — ждём её.
  try { if (store.activeScoutExists()) return; } catch { /* ignore */ }

  const busy = store.activeProfileUuids();
  const scout = pickScout(busy);
  if (!scout) {
    health.available = false;
    logger.warn('[watch] Нет доступного скаута (все заняты/помечены) — проверю в следующий тик.', 'watch');
    return;
  }
  health.available = true;
  health.lastScout = scout;
  health.lastPickAt = new Date().toISOString();

  try {
    const task = store.createTask(
      {
        profileUuid: scout,
        postUrl: 'https://www.facebook.com/',
        commentText: `Наблюдение · скаут (${due.length} пост.)`,
        type: 'scout',
        posts: due.map((p) => ({
          id: p.id,
          postUrl: p.postUrl,
          pageName: p.pageName,
          adminProfileUuid: p.profileUuid,
          owner: p.owner,
        })),
      },
      { scheduledAt: queue.earliestSlot(scout, now, now), owner: 'local' },
    );
    queue.enqueue(task);
    health.lastError = null;
    logger.info(`[watch] Скаут запущен (профиль ${scout.slice(0, 8)}…), постов к проверке: ${due.length}.`, 'watch');
  } catch (e) {
    health.lastError = e.message;
    logger.error(`[watch] Не удалось запустить скаута: ${e.message}`, 'watch');
  }
}

// Вызывается очередью, когда фоновая чистка ('hidebg') завершилась — отмечаем
// результат в записи наблюдения (для статуса в UI): время и сколько скрыто.
function onCleanFinished(task) {
  try {
    const w = store.findWatchByPostProfile(task.payload.postUrl, task.payload.profileUuid);
    if (!w) return;
    const t = store.get(task.id);
    const err = t && t.status === 'error' ? (t.error || 'ошибка') : null;
    let hidden = 0;
    if (t && Array.isArray(t.logs)) {
      for (const line of t.logs) {
        const m = /Скрыто:\s*(\d+)/.exec(line);
        if (m) hidden = parseInt(m[1], 10);
      }
    }
    store.updateWatchState(w.id, {
      lastCleanAt: new Date().toISOString(),
      dirty: false,
      lastHidden: hidden,
      lastError: err,
    });
  } catch { /* ignore */ }
}

function getHealth() {
  return { ...health };
}

function start() {
  if (timer) return;
  timer = setInterval(tick, 60000);
  if (timer.unref) timer.unref();
  logger.info('[watch] Планировщик наблюдения запущен (тик 60с).', 'watch');
}

module.exports = {
  start, tick, onCleanFinished, getHealth,
};
