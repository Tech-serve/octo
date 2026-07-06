const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { logger } = require('./logger');
const store = require('./taskStore');
const queue = require('./queue');
const { listProfiles } = require('./octoService');
const { uniquifyBatch } = require('./textDecorator');

const app = express();
app.use(cors({ origin: config.corsOrigin }));
// Лимит побольше — картинки приходят как base64 в JSON.
app.use(express.json({ limit: '30mb' }));
// Раздаём прикреплённые картинки (для истории/просмотра).
fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir));

// Сохранить картинку из data:URL в файл. Возвращает путь или null.
function saveImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const file = path.join(config.uploadDir, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

// Список профилей Octo для выпадающего списка на фронте.
app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await listProfiles();
    res.json({ profiles });
  } catch (err) {
    if (err.code === 'NO_TOKEN') {
      return res.status(200).json({ profiles: [], tokenMissing: true, error: err.message });
    }
    const status = err.response?.status;
    const detail = status === 401 ? 'Неверный OCTO_API_TOKEN' : err.message;
    logger.error(`Ошибка получения профилей: ${detail}`, 'api');
    res.status(502).json({ profiles: [], error: `Не удалось загрузить профили: ${detail}` });
  }
});

// Создание задач -> в очередь. Принимаем posts[] = [{ url, image }] (image —
// data:URL base64, необязателен). На каждый пост — своя задача с уникальным
// хвостом текста и (если есть) своей картинкой. Совместимо со старым postUrls[].
app.post('/api/tasks', (req, res) => {
  const {
    profileUuid, postUrl, postUrls, posts, entries, dialogs, commentText,
  } = req.body || {};

  // РЕЖИМ 3: диалоги (дерево комментариев). Один пост, несколько тредов;
  // внутри треда реплики идут цепочкой (depends_on) с паузой 5–30 мин.
  if (Array.isArray(dialogs)) {
    const url = typeof postUrl === 'string' ? postUrl.trim() : '';
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Некорректная ссылка на пост' });
    }

    const clean = dialogs
      .map((d) => ({
        steps: (Array.isArray(d.steps) ? d.steps : [])
          .map((s) => ({
            profileUuid: s.profileUuid,
            text: typeof s.text === 'string' ? s.text.trim() : '',
            replyTo: (s.replyTo === 0 || s.replyTo) ? s.replyTo : null,
            image: s.image || null,
          }))
          .filter((s) => s.profileUuid && s.text),
      }))
      .filter((d) => d.steps.length > 0);

    if (!url || clean.length === 0) {
      return res.status(400).json({ error: 'Заполните пост и хотя бы один диалог' });
    }

    // Лимит одинаковых на каждый фейк.
    for (const d of clean) {
      for (const s of d.steps) {
        if (store.countSameForProfile(s.profileUuid, s.text) + 1 > config.maxSamePerProfile) {
          return res.status(400).json({ error: `Лимит ${config.maxSamePerProfile} одинаковых на фейк исчерпан для одного из фейков.` });
        }
      }
    }

    const reqNow = Date.now();
    const gapMin = config.mode3GapMinMs;
    const gapMax = Math.max(config.mode3GapMaxMs, gapMin);
    const spread = config.mode2SpreadMs;
    const allCreated = [];

    clean.forEach((d, di) => {
      const dialogId = crypto.randomUUID();
      // Старт диалога: первый — сразу, следующие — со случайным разбросом.
      let cursor = reqNow + (di === 0 ? 0 : Math.round(Math.random() * spread));
      cursor = queue.earliestSlot(d.steps[0].profileUuid, cursor, reqNow);
      const stepTasks = [];

      d.steps.forEach((s, idx) => {
        const scheduledAt = cursor;
        cursor += Math.round(gapMin + Math.random() * (gapMax - gapMin));

        let imagePath = null;
        try {
          imagePath = saveImage(s.image);
        } catch (err) {
          logger.warn(`Не удалось сохранить картинку: ${err.message}`, 'api');
        }

        const replyToText = (s.replyTo != null && d.steps[s.replyTo]) ? d.steps[s.replyTo].text : null;
        const dependsOn = idx > 0 ? stepTasks[idx - 1].id : null;

        const task = store.createTask(
          {
            profileUuid: s.profileUuid,
            postUrl: url,
            commentText: s.text,
            baseText: s.text,
            imagePath,
            replyToText,
          },
          {
            scheduledAt, dialogId, stepOrder: idx + 1, dependsOn,
          },
        );
        queue.enqueue(task);
        stepTasks.push(task);
        allCreated.push({
          taskId: task.id,
          status: task.status,
          postUrl: url,
          profileUuid: s.profileUuid,
          scheduledAt,
          delayed: scheduledAt > reqNow + 1000,
          stepOrder: idx + 1,
          dialogId,
        });
      });
    });

    logger.info(`Режим 3: создано задач ${allCreated.length} (диалогов ${clean.length})`, 'api');
    return res.status(202).json({ tasks: allCreated, count: allCreated.length, ...queue.stats() });
  }

  // РЕЖИМ 2: один пост -> много фейков, каждый со своим комментом/картинкой,
  // запуск СО СТАГГЕРОМ по времени (не одновременно).
  if (Array.isArray(entries)) {
    const url = typeof postUrl === 'string' ? postUrl.trim() : '';
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Некорректная ссылка на пост' });
    }

    const list = entries
      .map((e) => ({
        profileUuid: e.profileUuid,
        comment: typeof e.commentText === 'string' ? e.commentText.trim() : '',
        image: e.image || null,
      }))
      .filter((e) => e.profileUuid && e.comment);

    if (!url || list.length === 0) {
      return res.status(400).json({ error: 'Заполните пост, фейки и комментарии' });
    }

    // Лимит одинаковых на каждый фейк.
    for (const e of list) {
      const already = store.countSameForProfile(e.profileUuid, e.comment);
      if (already + 1 > config.maxSamePerProfile) {
        return res.status(400).json({
          error: `Лимит ${config.maxSamePerProfile} одинаковых на фейк исчерпан для одного из фейков.`,
        });
      }
    }

    const reqNow = Date.now();
    const spread = config.mode2SpreadMs;

    const created = list.map((e, idx) => {
      // Первый фейк — СРАЗУ (не ждём). Остальные — в случайный момент в окне
      // [0, MODE2_SPREAD] минут (кто через минуту, кто через час). Но не раньше,
      // чем сам фейк освободится.
      const offset = idx === 0 ? 0 : Math.round(Math.random() * spread);
      const scheduledAt = queue.earliestSlot(e.profileUuid, reqNow + offset, reqNow);

      let imagePath = null;
      try {
        imagePath = saveImage(e.image);
      } catch (err) {
        logger.warn(`Не удалось сохранить картинку: ${err.message}`, 'api');
      }

      const task = store.createTask({
        profileUuid: e.profileUuid,
        postUrl: url,
        commentText: e.comment,
        baseText: e.comment,
        imagePath,
      }, { scheduledAt });
      queue.enqueue(task);
      return {
        taskId: task.id,
        status: task.status,
        postUrl: url,
        profileUuid: e.profileUuid,
        scheduledAt,
        delayed: scheduledAt > reqNow + 1000,
        hasImage: !!imagePath,
      };
    });
    logger.info(`Режим 2: создано задач ${created.length} на пост ${url}`, 'api');
    return res.status(202).json({ tasks: created, count: created.length, ...queue.stats() });
  }

  // Нормализуем вход в массив { url, image }.
  let items;
  if (Array.isArray(posts)) {
    items = posts.map((p) => ({
      url: typeof p.url === 'string' ? p.url.trim() : '',
      image: p.image || null,
    }));
  } else {
    const urls = (Array.isArray(postUrls) ? postUrls : [postUrl])
      .map((u) => (typeof u === 'string' ? u.trim() : ''));
    items = urls.map((u) => ({ url: u, image: null }));
  }
  items = items.filter((it) => it.url);

  const base = typeof commentText === 'string' ? commentText.trim() : '';
  if (!profileUuid || items.length === 0 || !base) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }

  // Валидация каждой ссылки.
  for (const it of items) {
    try {
      // eslint-disable-next-line no-new
      new URL(it.url);
    } catch {
      return res.status(400).json({ error: `Некорректная ссылка на пост: ${it.url}` });
    }
  }

  // Лимит одинаковых постов (по базовому тексту) на один фейк.
  const existing = store.countSameForProfile(profileUuid, base);
  if (existing + items.length > config.maxSamePerProfile) {
    const left = Math.max(0, config.maxSamePerProfile - existing);
    return res.status(400).json({
      error: `Лимит ${config.maxSamePerProfile} одинаковых постов на фейк. Уже есть ${existing}, можно добавить ещё ${left}.`,
    });
  }

  // Уникальные хвосты текста (слова не меняем — только концовка + эмодзи).
  const variants = uniquifyBatch(base, items.length);

  // Разбивка по времени. Батч встаёт В ОЧЕРЕДЬ ПОСЛЕ текущей занятости фейка
  // (в т.ч. если задачи на этот фейк уже дал другой баер).
  const reqNow = Date.now();
  const minGap = config.postDelayMinMs;
  const maxGap = Math.max(config.postDelayMaxMs, minGap);
  // Умное размещение старта пачки: заполняем ближайшее свободное окно фейка.
  let cursor = queue.earliestSlot(profileUuid, reqNow, reqNow);

  const created = items.map((it, idx) => {
    const scheduledAt = cursor;
    cursor += Math.round(minGap + Math.random() * (maxGap - minGap));

    let imagePath = null;
    try {
      imagePath = saveImage(it.image);
    } catch (e) {
      logger.warn(`Не удалось сохранить картинку: ${e.message}`, 'api');
    }

    const task = store.createTask({
      profileUuid,
      postUrl: it.url,
      commentText: variants[idx], // уже с уникальным хвостом
      baseText: base, // для лимита одинаковых
      imagePath,
    }, { scheduledAt });
    queue.enqueue(task);
    return {
      taskId: task.id,
      status: task.status,
      postUrl: it.url,
      profileUuid,
      scheduledAt,
      delayed: scheduledAt > reqNow + 1000,
      hasImage: !!imagePath,
    };
  });
  logger.info(`Создано задач: ${created.length} (профиль ${profileUuid})`, 'api');

  res.status(202).json({
    message: `Поставлено в очередь задач: ${created.length}`,
    tasks: created,
    count: created.length,
    ...queue.stats(),
  });
});

// Сколько ещё занят каждый профиль (мс, ОСТАТОК от серверного времени).
// Учитываем сериализацию: задачи одного профиля идут по очереди. Для бегущей
// задачи берём реальный старт, для будущих — запланированное время; длительность
// — фактическое скользящее среднее. Возвращаем остаток, чтобы не зависеть от
// расхождения часов клиента и сервера.
app.get('/api/busy', (req, res) => {
  res.json({ busy: queue.busyRemaining(), avgDurationMs: queue.getAvgDurationMs() });
});

// Отмена задач по id (только те, что ещё не стартовали).
app.post('/api/tasks/cancel', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const results = ids.map((id) => ({ id, result: queue.cancel(id) }));
  const canceled = results.filter((r) => r.result === 'canceled').length;
  res.json({ canceled, results });
});

// Статус конкретной задачи (для поллинга с фронта)
app.get('/api/tasks/:id', (req, res) => {
  const task = store.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  res.json(store.toPublic(task));
});

// Список всех задач + статистика очереди
app.get('/api/tasks', (req, res) => {
  res.json({ tasks: store.list(), ...queue.stats() });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ...queue.stats() });
});

// Автоочистка: удалить задачи и картинки старше 30 дней (при старте + раз в сутки).
function cleanupOld() {
  try {
    const removed = store.pruneOld(30);
    for (const p of removed) {
      try { fs.unlinkSync(p); } catch { /* уже нет */ }
    }
    // Осиротевшие файлы старше 30 дней (на случай, если задача уже удалена).
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(config.uploadDir)) {
      const fp = path.join(config.uploadDir, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch { /* пропустим */ }
    }
    if (removed.length) logger.info(`Автоочистка: удалено задач ${removed.length}`, 'cleanup');
  } catch (e) {
    logger.warn(`Автоочистка не удалась: ${e.message}`, 'cleanup');
  }
}

app.listen(config.port, () => {
  logger.info(`Бэкенд запущен на порту ${config.port} (maxConcurrent=${config.maxConcurrent})`, 'boot');
  cleanupOld();
  const cl = setInterval(cleanupOld, 24 * 3600 * 1000);
  if (cl.unref) cl.unref();
  // Восстанавливаем незавершённые задачи из БД (прерванные рестартом).
  try {
    const pending = store.loadPending();
    for (const task of pending) queue.enqueue(task);
    if (pending.length) logger.info(`Восстановлено задач из БД: ${pending.length}`, 'boot');
  } catch (e) {
    logger.error(`Не удалось восстановить задачи из БД: ${e.message}`, 'boot');
  }
});
