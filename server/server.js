const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { logger } = require('./logger');
const store = require('./taskStore');
const queue = require('./queue');
const whitelistJob = require('./whitelistJob');
const { listProfiles } = require('./octoService');
const { uniquifyBatch } = require('./textDecorator');
const { handleSsoAccept, ownerMiddleware, whoAmI } = require('./auth');

const app = express();
// За Cloudflare Tunnel / прокси: доверяем X-Forwarded-* (протокол и т.п.).
app.set('trust proxy', true);
// origin:true отражает источник запроса и разрешает credentials (куку). При
// встраивании в iframe фронт и API — один origin, CORS не срабатывает вовсе.
app.use(cors({
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
  credentials: true,
}));
app.use(cookieParser());
// Лимит побольше — картинки приходят как base64 в JSON.
app.use(express.json({ limit: '30mb' }));
// Разрешаем встраивание в iframe только с домена таск-менеджера (если задан).
// НЕ ставим X-Frame-Options — он перебил бы frame-ancestors.
if (config.frameAncestor) {
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${config.frameAncestor}`);
    next();
  });
}
// Раздаём прикреплённые картинки (для истории/просмотра).
fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir));

// SSO: приём одноразового токена от таск-менеджера + «кто я».
app.post('/api/sso/accept', handleSsoAccept);
app.get('/api/me', whoAmI);

// Сохранить картинку из data:URL в файл. Возвращает путь или null.
// Также принимает уже загруженный файл (URL /uploads/...): копирует его в НОВЫЙ
// файл задачи — чтобы задача не зависела от исходного черновика (его могут
// заменить/удалить), и картинка точно осталась в истории даже если varyImage
// на клиенте не смог перегнать URL в data:URL.
function saveImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const asUpload = dataUrl.match(/\/uploads\/([\w.-]+\.(?:png|jpe?g|webp|gif))(?:\?|#|$)/i);
  if (asUpload) {
    try {
      const src = path.join(config.uploadDir, path.basename(asUpload[1]));
      if (fs.existsSync(src)) {
        const dst = path.join(config.uploadDir, `${crypto.randomUUID()}${path.extname(src)}`);
        fs.copyFileSync(src, dst);
        return dst;
      }
    } catch { /* ниже попробуем как data:URL */ }
    return null;
  }
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
app.get('/api/profiles', ownerMiddleware, async (req, res) => {
  try {
    const profiles = await listProfiles();
    const flags = store.listFlags();
    const whitelist = store.listWhitelist();
    res.json({
      profiles: profiles.map((p) => {
        const wl = whitelist[p.uuid];
        return {
          ...p,
          flag: flags[p.uuid] || null,
          fbName: (wl && wl.fbName) || '',
          fbId: (wl && wl.fbId) || '',
        };
      }),
    });
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
app.post('/api/tasks', ownerMiddleware, (req, res) => {
  const owner = req.owner;
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
    const minOff = config.mode2MinMs;
    const allCreated = [];

    clean.forEach((d, di) => {
      const dialogId = crypto.randomUUID();
      // Старт диалога: первый — сразу, следующие — не раньше MODE2_MIN и до разброса.
      let cursor = reqNow + (di === 0 ? 0 : minOff + Math.round(Math.random() * Math.max(0, spread - minOff)));
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

        // Ответ идёт на БОЛЕЕ РАННИЙ шаг (индекс < idx). Если индекс битый/устарел
        // (например, остался после удаления реплик и указывает на себя/будущее) —
        // по умолчанию отвечаем на корень ветки (шаг 0 = верхний коммент).
        const rt = (s.replyTo != null && s.replyTo < idx && d.steps[s.replyTo]) ? s.replyTo : (idx > 0 ? 0 : null);
        const replyToText = (rt != null && d.steps[rt]) ? d.steps[rt].text : null;
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
            scheduledAt, dialogId, stepOrder: idx + 1, dependsOn, owner,
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
          commentText: s.text,
          imageUrl: imagePath ? `/uploads/${path.basename(imagePath)}` : null,
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
    const minOff = config.mode2MinMs;
    // Номер фейка в пачке — фронт шлёт по одному фейку за запрос (чтобы не раздувать
    // тело картинками и не ловить 502). По нему решаем: старт сразу (0) или со сдвигом.
    const reqStagger = (req.body && Number.isInteger(req.body.staggerIndex)) ? req.body.staggerIndex : null;

    const created = list.map((e, idx) => {
      // Первый фейк — СРАЗУ (не ждём). Остальные — в случайный момент в окне
      // [MODE2_MIN, MODE2_SPREAD] минут: не раньше минимума (чтобы не стартовали
      // одновременно с первым) и не позже разброса. И не раньше, чем сам фейк освободится.
      const sIdx = reqStagger != null ? reqStagger : idx;
      const offset = sIdx === 0 ? 0 : minOff + Math.round(Math.random() * Math.max(0, spread - minOff));
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
      }, { scheduledAt, owner });
      queue.enqueue(task);
      return {
        taskId: task.id,
        status: task.status,
        postUrl: url,
        profileUuid: e.profileUuid,
        scheduledAt,
        delayed: scheduledAt > reqNow + 1000,
        hasImage: !!imagePath,
        commentText: e.comment,
        imageUrl: imagePath ? `/uploads/${path.basename(imagePath)}` : null,
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
    }, { scheduledAt, owner });
    queue.enqueue(task);
    return {
      taskId: task.id,
      status: task.status,
      postUrl: it.url,
      profileUuid,
      scheduledAt,
      delayed: scheduledAt > reqNow + 1000,
      hasImage: !!imagePath,
      commentText: variants[idx],
      imageUrl: imagePath ? `/uploads/${path.basename(imagePath)}` : null,
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
// Занятость профилей — общая (фейки — общий пул, таймеры общие).
app.get('/api/busy', ownerMiddleware, (req, res) => {
  res.json({ busy: queue.busyRemaining(), avgDurationMs: queue.getAvgDurationMs() });
});

// Отмена задач по id (только те, что ещё не стартовали). Баер может отменять
// только свои задачи.
app.post('/api/tasks/cancel', ownerMiddleware, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const results = ids.map((id) => {
    const task = store.get(id);
    if (!task) return { id, result: 'not_found' };
    if (config.authEnabled && task.owner !== req.owner) return { id, result: 'forbidden' };
    return { id, result: queue.cancel(id) };
  });
  const canceled = results.filter((r) => r.result === 'canceled').length;
  res.json({ canceled, results });
});

// Снять пометку «требует проверки» с фейка (баер подтвердил checkpoint вручную).
app.post('/api/flags/clear', ownerMiddleware, (req, res) => {
  const uuid = req.body && req.body.uuid;
  if (!uuid) return res.status(400).json({ error: 'uuid обязателен' });
  store.clearProfileFlag(uuid);
  res.json({ ok: true });
});

// Разовый пересбор белого списка: открывает переданные профили по очереди,
// читает реальную FB-идентичность (id+имя) и пишет в whitelist. Скоуп задаёт
// фронт (обычно — текущий отфильтрованный список фейков). Запуск фоновый.
app.post('/api/whitelist/rebuild', ownerMiddleware, (req, res) => {
  const uuids = (req.body && Array.isArray(req.body.uuids)) ? req.body.uuids : [];
  const result = whitelistJob.rebuild(uuids, { concurrency: req.body && req.body.concurrency });
  if (!result.started) {
    const msg = result.reason === 'already-running'
      ? 'Пересбор уже идёт'
      : 'Список профилей пуст';
    return res.status(409).json({ error: msg, ...result });
  }
  res.json({ ok: true, ...result });
});

// Прогресс пересбора белого списка (для поллинга с фронта).
app.get('/api/whitelist/status', ownerMiddleware, (req, res) => {
  res.json(whitelistJob.status());
});

// Остановить пересбор.
app.post('/api/whitelist/cancel', ownerMiddleware, (req, res) => {
  res.json({ canceled: whitelistJob.cancel() });
});

// Продолжить оборвавшийся диалог (режим 3): пересоздать упавший шаг и все
// последующие, сохранив порядок, текст ответа (replyToText) и картинки. Ранние
// DONE-шаги остаются; цепочка зависимостей строится заново от них.
app.post('/api/dialog/continue', ownerMiddleware, (req, res) => {
  const dialogId = req.body && req.body.dialogId;
  if (!dialogId) return res.status(400).json({ error: 'dialogId обязателен' });
  const steps = store.listByDialog(dialogId);
  if (!steps.length) return res.status(404).json({ error: 'Диалог не найден' });
  if (config.authEnabled && steps[0].owner !== req.owner) {
    return res.status(404).json({ error: 'Диалог не найден' });
  }

  const DONE = store.STATUS.DONE;
  const resumeIdx = steps.findIndex((t) => t.status !== DONE);
  if (resumeIdx < 0) return res.status(400).json({ error: 'Все шаги диалога уже выполнены' });
  for (let i = 0; i < resumeIdx; i += 1) {
    if (steps[i].status !== DONE) {
      return res.status(400).json({ error: 'Ранние шаги диалога не завершены.' });
    }
  }

  const reqNow = Date.now();
  const gapMin = config.mode3GapMinMs;
  const gapMax = Math.max(config.mode3GapMaxMs, gapMin);
  let prevId = resumeIdx > 0 ? steps[resumeIdx - 1].id : null;
  let cursor = queue.earliestSlot(steps[resumeIdx].payload.profileUuid, reqNow, reqNow);

  // Старые упавшие/отменённые шаги удаляем — пересоздаём заново.
  for (let i = resumeIdx; i < steps.length; i += 1) {
    try { store.deleteTask(steps[i].id); } catch { /* ignore */ }
  }

  const created = [];
  for (let i = resumeIdx; i < steps.length; i += 1) {
    const s = steps[i];
    const scheduledAt = cursor;
    cursor += Math.round(gapMin + Math.random() * (gapMax - gapMin));
    const task = store.createTask(
      {
        profileUuid: s.payload.profileUuid,
        postUrl: s.payload.postUrl,
        commentText: s.payload.commentText,
        baseText: s.payload.baseText,
        imagePath: s.payload.imagePath,
        replyToText: s.payload.replyToText,
      },
      {
        scheduledAt, dialogId, stepOrder: s.stepOrder, dependsOn: prevId, owner: s.owner,
      },
    );
    queue.enqueue(task);
    prevId = task.id;
    created.push(store.toPublic(task));
  }
  res.json({ ok: true, created });
});

// Повторить одиночную упавшую задачу (режимы 1/2) — пересоздаём с тем же
// содержимым. Для диалогов используется «Продолжить» (см. выше).
app.post('/api/tasks/:id/retry', ownerMiddleware, (req, res) => {
  const old = store.get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Задача не найдена' });
  if (config.authEnabled && old.owner !== req.owner) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }
  if (old.dialogId) {
    return res.status(400).json({ error: 'Для диалога используйте «Продолжить»' });
  }
  const now = Date.now();
  const task = store.createTask(
    {
      profileUuid: old.payload.profileUuid,
      postUrl: old.payload.postUrl,
      commentText: old.payload.commentText,
      baseText: old.payload.baseText,
      imagePath: old.payload.imagePath,
      replyToText: old.payload.replyToText,
      type: old.payload.type,
    },
    { scheduledAt: queue.earliestSlot(old.payload.profileUuid, now, now), owner: old.owner },
  );
  queue.enqueue(task);
  res.json({ ok: true, task: store.toPublic(task) });
});

// РЕЖИМ 4 · ЧИСТКА: скрыть чужие комменты на посте от имени профиля-админа.
// Наши фейки (по вайт-листу) не трогаем — это делает воркер hideForeignComments.
app.post('/api/hide', ownerMiddleware, (req, res) => {
  const profileUuid = req.body && req.body.profileUuid;
  const postUrl = req.body && (req.body.postUrl || '').trim();
  if (!profileUuid) return res.status(400).json({ error: 'Выберите профиль-админ' });
  if (!postUrl) return res.status(400).json({ error: 'Введите ссылку на пост' });
  const owner = config.authEnabled ? req.owner : 'local';
  const now = Date.now();
  const task = store.createTask(
    { profileUuid, postUrl, commentText: 'Чистка · скрыть чужие комментарии', type: 'hide' },
    { scheduledAt: queue.earliestSlot(profileUuid, now, now), owner },
  );
  queue.enqueue(task);
  res.status(202).json({
    tasks: [{
      taskId: task.id,
      status: task.status,
      postUrl,
      profileUuid,
      scheduledAt: task.scheduledAt,
      commentText: task.payload.commentText,
    }],
    count: 1,
    ...queue.stats(),
  });
});

// Статус конкретной задачи (для поллинга с фронта). Только своя задача.
app.get('/api/tasks/:id', ownerMiddleware, (req, res) => {
  const task = store.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (config.authEnabled && task.owner !== req.owner) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }
  res.json(store.toPublic(task));
});

// Список задач + статистика очереди. Баер видит только свои задачи.
app.get('/api/tasks', ownerMiddleware, (req, res) => {
  const owner = config.authEnabled ? req.owner : null;
  res.json({ tasks: store.list(owner), ...queue.stats() });
});

// ── Черновики операций: надёжное серверное хранение вместо localStorage ──
// Структура вкладок (key='tabs') и поля каждой операции (key='op:<mode>:<id>').
// Картинки — файлами через /api/drafts/image (в data только их URL).
app.get('/api/drafts', ownerMiddleware, (req, res) => {
  res.json({ items: store.getDrafts(req.owner) });
});

app.put('/api/drafts/:key', ownerMiddleware, (req, res) => {
  const key = String(req.params.key || '');
  if (!/^(tabs|op:\d+:\d+)$/.test(key)) return res.status(400).json({ error: 'Некорректный ключ' });
  store.putDraft(req.owner, key, req.body ?? null);
  res.json({ ok: true });
});

app.delete('/api/drafts/:key', ownerMiddleware, (req, res) => {
  const key = String(req.params.key || '');
  if (!/^(tabs|op:\d+:\d+)$/.test(key)) return res.status(400).json({ error: 'Некорректный ключ' });
  store.deleteDraft(req.owner, key);
  res.json({ ok: true });
});

// Загрузка картинки операции ФАЙЛОМ. Тело: { image: dataURL }. Возвращает { url }.
app.post('/api/drafts/image', ownerMiddleware, (req, res) => {
  const p = saveImage(req.body && req.body.image);
  if (!p) return res.status(400).json({ error: 'Не распознан формат картинки' });
  res.json({ url: `/uploads/${path.basename(p)}` });
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
    // Осиротевшие файлы старше 30 дней (на случай, если задача уже удалена). НО
    // НЕ трогаем те, на которые ссылается любой черновик (поля/результаты), иначе
    // картинки пропадают из истории и логов операций.
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const keep = store.referencedUploadFiles();
    for (const f of fs.readdirSync(config.uploadDir)) {
      if (keep.has(f)) continue;
      const fp = path.join(config.uploadDir, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch { /* пропустим */ }
    }
    if (removed.length) logger.info(`Автоочистка: удалено задач ${removed.length}`, 'cleanup');
  } catch (e) {
    logger.warn(`Автоочистка не удалась: ${e.message}`, 'cleanup');
  }
}

// Прод: если фронт собран (client/dist) — отдаём его с того же адреса, что и API
// (один origin: удобно для туннеля и iframe). В dev фронт крутит Vite (:5173),
// dist нет — этот блок пропускается.
const clientDist = path.resolve(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  // index.html НЕ кешируем (иначе браузер/туннель/iframe держат старый бандл после
  // деплоя). Хешированные ассеты (index-<hash>.js/.css) неизменяемы — кешируем навсегда.
  app.use(express.static(clientDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  // SPA-fallback: любой GET не под /api и /uploads отдаёт index.html (тоже без кеша).
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(path.join(clientDist, 'index.html'));
  });
  logger.info('Фронт отдаётся из client/dist (один origin с API)', 'boot');
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
