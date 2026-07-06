const fs = require('fs');
const { connectToOcto, disconnectOcto } = require('./octoService');
const config = require('./config');
const {
  sleep, rand, randInt,
  createPersona, getPersona,
  moveMouse, idleMouse, humanClick, humanScroll, humanType, readingTimeFor,
} = require('./humanize');

// Мультиязычные фрагменты aria-label поля комментария. Берём КОРНИ слов, а не
// целые формы: FB подставляет разные («Напишіть коментар…», «Коментувати як…»,
// «Прокомментировать как…»), и точная форма не совпадала бы. Регистронезависимо.
const COMMENT_ARIA = [
  'комментар', 'комментир', 'коммент',        // ru: комментарий/прокомментировать
  'коментув', 'коментар', 'напиш',            // uk: коментувати/коментар/напишіть
  'comment', 'comentar', 'comentário',        // en/es/pt
  'kommentar', 'kommentier', 'commenter',     // de/fr
  'commento', 'skomentuj', 'yorum',           // it/pl/tr
  'escrib', 'écri', 'schreib',                // «написать» в es/fr/de
];

// Корни подписей кнопки отправки на многих языках (регистронезависимо).
// Это лишь «бонус», чтобы иногда по-человечески кликнуть кнопку; ОСНОВНОЙ и
// полностью язык-независимый способ отправки — Enter (см. submitComment).
const SEND_ARIA = [
  'отправ', 'прокоммент', 'опублик',          // ru
  'опублік', 'надіслати', 'коментув',         // uk
  'comment', 'post', 'publish', 'send',       // en
  'public', 'coment', 'enviar', 'envoy',      // es/pt/fr
  'publi', 'kommentier', 'senden',            // fr/de
  'invia', 'pubblica', 'commenta',            // it
  'opublikuj', 'skomentuj', 'wyślij',         // pl
  'gönder', 'yorum', 'yayınla',               // tr
  'verstuur', 'reageer', 'skicka',            // nl/sv
];

function buildCommentSelector() {
  return COMMENT_ARIA
    .map((label) => `div[role="textbox"][aria-label*="${label}" i]`)
    .join(', ');
}

// Пост-пермалинк часто открывается в МОДАЛЬНОМ окне (div[role="dialog"]).
// Если оно есть — работаем внутри него: и поле, и скролл должны быть там.
async function getDialog(page) {
  const dialogs = await page.$$('div[role="dialog"]');
  for (const d of dialogs) {
    const box = await d.boundingBox().catch(() => null);
    if (box && box.width > 300 && box.height > 300) return d; // крупный видимый диалог
  }
  return null;
}

// Надёжный поиск поля комментария. Язык-НЕзависимо: сначала пробуем aria-label
// (внутри диалога, потом на странице), затем — ЛЮБОЙ видимый редактируемый
// textbox (contenteditable). Возвращает ElementHandle или null.
async function findCommentBox(page, timeoutMs) {
  const aria = buildCommentSelector();
  const inDlg = (s) => `div[role="dialog"] ${s}`;
  const selectors = [
    inDlg(aria),
    aria,
    inDlg('div[role="textbox"][contenteditable="true"]'),
    inDlg('div[contenteditable="true"]'),
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      let handles = [];
      try { handles = await page.$$(sel); } catch { continue; }
      for (const h of handles) {
        const box = await h.boundingBox().catch(() => null);
        if (!box || box.width < 40 || box.height < 8) continue; // невидимый/крошечный
        const ok = await h.evaluate((el) => {
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
          return el.isContentEditable
            || el.getAttribute('contenteditable') === 'true'
            || el.getAttribute('role') === 'textbox';
        }).catch(() => false);
        if (ok) return h;
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

// Отправка комментария. Основной способ — Enter (работает на ЛЮБОМ языке и не
// требует знать подпись кнопки). Иногда, по персоне, пробуем по-человечески
// кликнуть кнопку отправки, но только если уверенно нашли её по известной
// подписи И внутри диалога/композера — чтобы ничего лишнего не нажать.
async function submitComment(page, log) {
  if (Math.random() < getPersona(page).prefersButton) {
    const build = (prefix) => SEND_ARIA
      .map((l) => `${prefix}[role="button"][aria-label*="${l}" i]`)
      .join(', ');
    // Сначала строго внутри модального окна, затем — на странице.
    for (const sel of [build('div[role="dialog"] '), build('')]) {
      const btn = await page.$(sel).catch(() => null);
      if (!btn) continue;
      const box = await btn.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        log.info('[FB Bot] Отправка кликом по кнопке');
        await humanClick(page, btn);
        return;
      }
    }
  }
  log.info('[FB Bot] Отправка клавишей Enter (язык-независимо)');
  await page.keyboard.press('Enter');
}

// Признаки того, что FB показал проверку/капчу/логин, и продолжать нельзя.
// Приоритет — ЯЗЫК-НЕЗАВИСИМЫЕ сигналы (URL и элементы капчи): они одинаковы
// на любом языке интерфейса. Текстовые фразы — лишь дополнительная эвристика.
async function detectBlock(page) {
  const url = page.url();
  // 1. URL — не зависит от языка.
  if (/\/checkpoint\//i.test(url)) return 'checkpoint (проверка аккаунта)';
  if (/\/login\.php|\/login\/|\/login\?/i.test(url)) return 'страница логина (сессия не авторизована)';
  if (/two_step_verification|\/recover\/|\/confirmemail|\/disabled\//i.test(url)) {
    return 'проверка/восстановление аккаунта (URL)';
  }

  // 2. Элементы капчи — тоже язык-независимо (по src/id/title).
  const captcha = await page.$(
    'iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], '
    + 'iframe[title*="captcha" i], div[id*="captcha" i], img[src*="captcha" i]',
  ).catch(() => null);
  if (captcha) return 'обнаружена капча';

  // 3. Дополнительно: текстовые фразы на ряде языков (не исчерпывающе).
  const blockPhrases = [
    // ru
    'подтвердите, что это вы', 'проверка безопасности', 'вы временно заблокированы',
    'введите символы', 'подозрительная активность',
    // en
    'confirm your identity', 'security check', 'you\'re temporarily blocked',
    'enter the characters', 'suspicious activity', 'complete a security check',
    'captcha', 'we need to confirm',
    // uk
    'підтвердьте, що це ви', 'перевірка безпеки', 'вас тимчасово заблоковано',
    // es
    'confirma tu identidad', 'comprueba que eres tú', 'actividad sospechosa',
    // pt
    'confirme sua identidade', 'verificação de segurança',
    // de
    'bestätige deine identität', 'sicherheitscheck', 'verdächtige aktivität',
    // fr
    'confirmez votre identité', 'vérification de sécurité', 'activité suspecte',
  ];

  const bodyText = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
  for (const phrase of blockPhrases) {
    if (bodyText.includes(phrase.toLowerCase())) return `обнаружена проверка FB: "${phrase}"`;
  }

  return null;
}

// Найти комментарий по тексту (для режима ответа). Прокручивает, чтобы
// подгрузить комментарии. Возвращает ElementHandle контейнера или null.
async function findCommentByText(page, text, timeoutMs) {
  const snippet = String(text).trim().slice(0, 60);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const handle = await page.evaluateHandle((snip) => {
      if (!snip) return null;
      const all = document.querySelectorAll('div, span, li');
      let leaf = null;
      for (const el of all) {
        if (el.childElementCount <= 4 && el.textContent && el.textContent.includes(snip)) { leaf = el; break; }
      }
      if (!leaf) return null;
      let c = leaf;
      for (let up = 0; up < 10 && c; up++) {
        if (c.getAttribute && c.getAttribute('role') === 'article') return c;
        c = c.parentElement;
      }
      return leaf;
    }, snippet);
    const el = handle.asElement();
    if (el) {
      // eslint-disable-next-line no-await-in-loop
      const box = await el.boundingBox().catch(() => null);
      if (box && box.height > 0) return el;
    }
    // eslint-disable-next-line no-await-in-loop
    await humanScroll(page, { bursts: 1 });
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(700);
  }
  return null;
}

// Кнопка «Ответить» на разных языках (по тексту, а не aria).
const REPLY_WORDS = ['ответить', 'відповісти', 'reply', 'responder', 'répondre', 'antworten', 'rispond', 'odpowied', 'yanıtla', 'svara', 'beantwoord'];

// Кликнуть «Ответить» внутри контейнера комментария.
async function clickReply(page, commentEl, log) {
  const btn = await commentEl.evaluateHandle((node, words) => {
    const cands = node.querySelectorAll('[role="button"], a, span, div');
    for (const b of cands) {
      const t = (b.innerText || b.textContent || '').trim().toLowerCase();
      if (t && t.length <= 20 && words.some((w) => t === w || t.startsWith(w))) return b;
    }
    return null;
  }, REPLY_WORDS);
  const b = btn.asElement();
  if (!b) return false;
  log.info('[FB Bot] Нажимаю «Ответить»...');
  await humanClick(page, b);
  return true;
}

// Текущее сфокусированное редактируемое поле (после клика «Ответить»).
async function findFocusedEditable(page) {
  const h = await page.evaluateHandle(() => {
    const a = document.activeElement;
    if (a && (a.isContentEditable || (a.getAttribute && a.getAttribute('role') === 'textbox'))) return a;
    return null;
  });
  return h.asElement();
}

// Прикрепить картинку к комментарию: находим input[type=file] в композере
// (язык-независимо) и подставляем файл, ждём появления превью, затем отдаём.
async function attachImage(page, imagePath, log) {
  const selectors = [
    'div[role="dialog"] input[type="file"][accept*="image" i]',
    'div[role="dialog"] input[type="file"]',
    'input[type="file"][accept*="image" i]',
    'input[type="file"]',
  ];
  let input = null;
  for (const sel of selectors) {
    // eslint-disable-next-line no-await-in-loop
    input = await page.$(sel);
    if (input) break;
  }
  if (!input) {
    log.warn('[FB Bot] Поле загрузки картинки не найдено — отправляю без картинки');
    return false;
  }

  log.info('[FB Bot] Прикрепляю картинку...');
  const scope = 'div[role="dialog"]';
  const imgsBefore = await page
    .$$eval(`${scope} img`, (els) => els.length)
    .catch(() => 0);

  await input.setInputFiles(imagePath);

  // Ждём превью недолго: FB может рисовать его не через <img> (фон/canvas),
  // поэтому таймаут короткий, а дальше — небольшое фиксированное ожидание.
  try {
    await page.waitForFunction(
      (before) => {
        const root = document.querySelector('div[role="dialog"]') || document.body;
        return root.querySelectorAll('img').length > before;
      },
      imgsBefore,
      { timeout: 5000 },
    );
    log.info('[FB Bot] Превью картинки загрузилось.');
    await sleep(rand(500, 1000));
  } catch {
    // Превью не подтвердилось — короткое ожидание на загрузку и продолжаем.
    await sleep(rand(1500, 2500));
  }
  return true;
}

async function leaveFacebookComment(payload, log, handle = {}) {
  const {
    profileUuid, postUrl, commentText, imagePath, replyToText,
  } = payload;
  let connection;
  // Если задачу отменили — прерываемся с понятной ошибкой (её поймает очередь).
  const ensureLive = () => { if (handle.canceled) throw new Error('Операция отменена пользователем'); };

  try {
    connection = await connectToOcto(profileUuid, log);
    handle.browser = connection.browser; // чтобы очередь могла закрыть сессию при отмене
    const { page } = connection;

    // Стабильная «персона» профиля: один и тот же профиль Octo ведёт себя
    // одинаково от запуска к запуску (темп печати, скорость мыши, привычки).
    page.__persona = createPersona(profileUuid);
    log.info(`[FB Bot] Персона профиля: mouseSpeed=${page.__persona.mouseSpeed.toFixed(2)}, typeBase=${Math.round(page.__persona.typeBase)}ms, typo=${(page.__persona.typoRate * 100).toFixed(1)}%, button=${(page.__persona.prefersButton * 100).toFixed(0)}%`);

    ensureLive();
    log.info(`[FB Bot] Переход на пост: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeout });

    // Первичное «осматривание» страницы: движение мышью + пауза чтения,
    // пропорциональная объёму текста на странице.
    await idleMouse(page);
    const textLen = await page.evaluate(() => (document.body?.innerText || '').length);
    const readMs = readingTimeFor(textLen);
    log.info(`[FB Bot] Читаю пост (~${Math.round(readMs / 1000)}с, объём текста ${textLen})...`);
    await sleep(readMs);

    // Проверка на капчу/чекпоинт/логин ДО любых действий.
    let block = await detectBlock(page);
    if (block) {
      throw new Error(`Действие прервано: ${block}. Требуется ручное вмешательство.`);
    }

    // Пост-пермалинк часто открывается в модальном окне. Если оно есть — курсор
    // и скролл должны быть ВНУТРИ него, иначе крутим фон, а комментарии не грузятся.
    const dialog = await getDialog(page);
    if (dialog) {
      log.info('[FB Bot] Пост открыт в модальном окне — работаю внутри него.');
      const db = await dialog.boundingBox().catch(() => null);
      if (db) {
        // Навести курсор в центр диалога, чтобы колесо скроллило именно его.
        await moveMouse(page, db.x + db.width * rand(0.4, 0.6), db.y + db.height * rand(0.4, 0.6));
      }
    }

    // Скролл к полю с РАННЕЙ ОСТАНОВКОЙ: подкручиваем по одному рывку и после
    // каждого проверяем, не появилось ли поле. Как только нашли — прекращаем
    // (человек не листает дальше цели). В модалке поле обычно уже на экране,
    // поэтому чаще всего скролла не будет вовсе — это и есть экономия времени.
    let commentBox;
    if (replyToText) {
      // РЕЖИМ ОТВЕТА: найти нужный комментарий, нажать «Ответить», взять поле.
      log.info(`[FB Bot] Режим ответа. Ищу комментарий: "${replyToText.slice(0, 40)}…"`);
      const target = await findCommentByText(page, replyToText, config.selectorTimeout);
      if (!target) throw new Error(`Не найден комментарий для ответа: "${replyToText.slice(0, 40)}…"`);
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(rand(500, 1200));
      ensureLive();
      const clicked = await clickReply(page, target, log);
      if (!clicked) throw new Error('Не найдена кнопка «Ответить» у комментария');
      await sleep(rand(700, 1500));
      commentBox = await findFocusedEditable(page);
      if (!commentBox) commentBox = await findCommentBox(page, 4000);
      if (!commentBox) throw new Error('Не найдено поле ответа');
    } else {
      // ВЕРХНЕУРОВНЕВЫЙ КОММЕНТ: скролл к полю с ранней остановкой.
      log.info('[FB Bot] Ищу поле для комментария...');
      commentBox = await findCommentBox(page, 1400);
      let hops = 0;
      while (!commentBox && hops < 4) {
        log.info(`[FB Bot] Поле не видно — подкручиваю (${hops + 1})...`);
        await humanScroll(page, { bursts: 1 });
        hops++;
        commentBox = await findCommentBox(page, 700);
      }
      if (Math.random() < 0.3) await idleMouse(page);
      if (!commentBox) {
        block = await detectBlock(page);
        if (block) throw new Error(`Действие прервано: ${block}.`);
        throw new Error('Поле для комментария не найдено (возможно, изменилась вёрстка FB или комментарии отключены)');
      }
    }

    // Довести поле в зону видимости и «дочитать» перед кликом.
    await commentBox.scrollIntoViewIfNeeded();
    await sleep(rand(500, 1200));

    ensureLive();
    log.info('[FB Bot] Навожу курсор и кликаю по полю...');
    await humanClick(page, commentBox);
    await sleep(rand(400, 1000));

    ensureLive();
    log.info('[FB Bot] Печатаю текст как человек...');
    await humanType(page, commentText);

    // Прикрепить картинку (если задана) — после текста, до отправки.
    if (imagePath) {
      try {
        await attachImage(page, imagePath, log);
      } catch (e) {
        log.warn(`[FB Bot] Не удалось прикрепить картинку: ${e.message}. Отправляю без неё.`);
      }
    }

    // Пауза перед отправкой: «перечитал написанное». Длиннее для длинного
    // комментария — как человек, который вычитывает больший текст.
    const reviewMs = 900 + Math.min(commentText.length, 300) * rand(8, 20);
    await sleep(reviewMs);
    if (Math.random() < getPersona(page).fidget + 0.2) await idleMouse(page);

    // Изредка «отвлёкся» — просто пауза, без каких-либо действий на странице.
    if (Math.random() < 0.12) {
      const awayMs = rand(3000, 9000);
      log.info(`[FB Bot] Небольшая пауза (~${Math.round(awayMs / 1000)}с)...`);
      await sleep(awayMs);
    }

    ensureLive();
    block = await detectBlock(page);
    if (block) throw new Error(`Действие прервано перед отправкой: ${block}.`);

    await submitComment(page, log);
    await sleep(rand(3500, 6000));

    // Проверка результата: если поле очистилось — комментарий, скорее всего, ушёл.
    let posted = false;
    try {
      const leftover = (await commentBox.innerText().catch(() => '')).trim();
      posted = leftover.length === 0;
    } catch {
      posted = true; // поле пропало из DOM — обычно это признак успешной отправки
    }

    if (posted) {
      log.info(`[FB Bot] Комментарий отправлен, поле очистилось. Профиль ${profileUuid}`);
    } else {
      log.warn('[FB Bot] Текст всё ещё в поле — возможно, комментарий не отправился (проверьте вручную)');
    }
  } finally {
    if (profileUuid) await disconnectOcto(profileUuid, log);
    // Картинку НЕ удаляем — она нужна для истории/просмотра (раздаётся статикой).
  }
}

module.exports = { leaveFacebookComment };
