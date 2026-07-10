const fs = require('fs');
const {
  connectToOcto, disconnectOcto, readFbIdentity, detectAccountStatus,
} = require('./octoService');
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

// Листать область поста ПО-ЧЕЛОВЕЧЕСКИ (колесо + паузы), но с курсором внутри
// модалки, если она есть — иначе колесо крутит ленту за постом. Без idle-блуждания,
// чтобы курсор не уползал. Используется и в поиске коммента, и в проверке.
async function scrollPostArea(page) {
  const dlg = await getDialog(page);
  if (dlg) {
    const db = await dlg.boundingBox().catch(() => null);
    if (db) await moveMouse(page, db.x + db.width * rand(0.3, 0.7), db.y + db.height * rand(0.35, 0.75));
  }
  await humanScroll(page, { bursts: 1, noIdle: true });
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
// Пусто ли поле комментария (FB его очищает после отправки). Пропал из DOM —
// тоже считаем отправленным.
async function commentFieldEmpty(box) {
  try {
    const t = (await box.innerText().catch(() => '')) || '';
    return t.trim().length === 0;
  } catch {
    return true;
  }
}

// Клик по кнопке отправки (если FB её показывает) — по подписи на многих языках.
async function clickSendButton(page, log) {
  const build = (prefix) => SEND_ARIA
    .map((l) => `${prefix}[role="button"][aria-label*="${l}" i]`)
    .join(', ');
  for (const sel of [build('div[role="dialog"] '), build('')]) {
    // eslint-disable-next-line no-await-in-loop
    const btn = await page.$(sel).catch(() => null);
    if (!btn) continue;
    // eslint-disable-next-line no-await-in-loop
    const box = await btn.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      log.info('[FB Bot] Отправка кликом по кнопке');
      // eslint-disable-next-line no-await-in-loop
      await humanClick(page, btn);
      return true;
    }
  }
  return false;
}

// Отправка коммента. ГЛАВНОЕ — перед Enter вернуть фокус В ПОЛЕ: после печати,
// движений мыши и прикрепления картинки фокус мог соскочить, и Enter уходил «в
// никуда» (текст оставался, коммент не отправлялся). Схема: фокус+Enter → если
// поле не очистилось, пробуем кнопку → ещё раз Enter.
async function submitComment(page, commentBox, log) {
  const enterOnField = async () => {
    try { await commentBox.focus(); } catch { /* ignore */ }
    await sleep(rand(150, 400));
    try { await commentBox.press('Enter'); } catch { await page.keyboard.press('Enter').catch(() => {}); }
  };

  log.info('[FB Bot] Отправка: фокус в поле + Enter');
  await enterOnField();
  await sleep(rand(1500, 2500));
  if (await commentFieldEmpty(commentBox)) return;

  log.info('[FB Bot] Поле не очистилось — пробую кнопку отправки');
  if (await clickSendButton(page, log)) {
    await sleep(rand(1500, 2500));
    if (await commentFieldEmpty(commentBox)) return;
  }

  log.info('[FB Bot] Ещё одна попытка: фокус + Enter');
  await enterOnField();
}

// Проверяем, что набранный текст РЕАЛЬНО попал в поле. FB иногда пересоздаёт
// reply-бокс / уводит фокус на первом символе — часть текста теряется, а потом
// «не подтверждён». Если не попал — перекликаем поле и печатаем заново (до 2 раз).
// refind() возвращает актуальный хэндл поля (или null), если старый отвалился.
async function ensureTextInField(page, box, text, log, refind) {
  const clean = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, '').trim();
  const want = clean(text).slice(0, 15);
  if (want.length < 4) return box;
  const readField = async (b) => { try { return clean(await b.innerText()); } catch { return null; } };

  let field = box;
  if (((await readField(field)) || '').includes(want)) return field;

  for (let i = 0; i < 2; i += 1) {
    log.info('[FB Bot] Текст не попал в поле (слетел фокус) — печатаю заново...');
    // eslint-disable-next-line no-await-in-loop
    if ((await readField(field)) === null && refind) {
      // eslint-disable-next-line no-await-in-loop
      const live = await refind().catch(() => null);
      if (live) field = live;
    }
    // eslint-disable-next-line no-await-in-loop
    try { await field.focus(); } catch { /* ignore */ }
    // eslint-disable-next-line no-await-in-loop
    await humanClick(page, field);
    // eslint-disable-next-line no-await-in-loop
    await sleep(rand(200, 500));
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Control+A').catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Backspace').catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await sleep(rand(150, 350));
    // eslint-disable-next-line no-await-in-loop
    await humanType(page, text);
    // eslint-disable-next-line no-await-in-loop
    await sleep(rand(400, 800));
    // eslint-disable-next-line no-await-in-loop
    if (((await readField(field)) || '').includes(want)) return field;
  }
  log.info('[FB Bot] Не удалось надёжно ввести текст — отправляю как есть.');
  return field;
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

// Прочитать, ЧТО реально показал FB, когда поле/коммент не нашлись, и вернуть
// правдивую причину вместо общего «поле не найдено». `hard` = причина
// однозначная (по тексту FB) — можно валить сразу после открытия поста; иначе
// это эвристика (нет статьи/композера), проверять только после полной загрузки.
async function diagnosePostProblem(page) {
  const url = page.url();
  const info = await page.evaluate(() => {
    const t = (document.body?.innerText || '').toLowerCase().replace(/\s+/g, ' ');
    return {
      t,
      hasArticle: !!document.querySelector('div[role="article"]'),
      hasComposer: !!document.querySelector('[contenteditable="true"], [role="textbox"]'),
    };
  }).catch(() => ({ t: '', hasArticle: false, hasComposer: false }));
  const t = info.t;
  const has = (arr) => arr.some((p) => t.includes(p));

  const gone = [
    "this content isn't available", 'this content isnt available', "content isn't available right now",
    "this page isn't available", 'this page isnt available', 'no longer available',
    'the link you followed may be broken', 'page may have been removed', "sorry, this content isn",
    'этот контент сейчас недоступен', 'контент недоступен', 'эта страница недоступна',
    'страница недоступна', 'публикация недоступна', 'материал недоступен', 'больше недоступ',
    'ссылка, по которой вы перешли', 'цей вміст зараз недоступний', 'ця сторінка недоступна',
    'este contenido no está disponible', 'esta página no está disponible', 'ya no está disponible',
    'este conteúdo não está disponível', 'esta página não está disponível', 'não está mais disponível',
    'dieser inhalt ist zurzeit nicht verfügbar', 'diese seite ist nicht verfügbar', 'nicht mehr verfügbar',
    "ce contenu n'est pas disponible", "cette page n'est pas disponible", "n'est plus disponible",
    'questo contenuto non è disponibile', 'questa pagina non è disponibile',
    'ta treść jest obecnie niedostępna', 'ta strona jest niedostępna',
    'bu içerik şu anda kullanılamıyor', 'bu sayfa kullanılamıyor',
  ];
  if (has(gone)) return { reason: 'пост недоступен или удалён (FB: «контент недоступен»)', hard: true };

  const login = [
    'log in to facebook', 'log into facebook', 'you must log in', 'log in or sign up',
    'войдите на facebook', 'вход на facebook', 'войти в аккаунт', 'увійдіть на facebook',
    'inicia sesión en facebook', 'entrar no facebook', 'melde dich bei facebook an',
    "connecte-toi à facebook", 'accedi a facebook',
  ];
  if (/\/login/i.test(url) || has(login)) return { reason: 'требуется вход — сессия FB не авторизована (разлогин)', hard: true };

  if (info.hasArticle && !info.hasComposer) return { reason: 'комментарии к посту отключены (поля ввода нет)', hard: false };
  if (!info.hasArticle) return { reason: 'пост не открылся/не загрузился (на странице нет публикации)', hard: false };
  return { reason: '', hard: false };
}

// Подпись текущей сортировки комментов (её кликаем, чтобы открыть меню) и пункт
// «Все комментарии» — мультиязычно. По умолчанию FB ставит «Самые актуальные»,
// и свежий родительский коммент туда может не попасть.
const SORT_TRIGGER = [
  'самые актуальные', 'найрелевантніші', 'актуальні коментарі', 'most relevant',
  'más relevantes', 'mais relevantes', 'relevantesten', 'plus pertinents',
  'più rilevanti', 'najtrafniejsze', 'en alakalı', 'все комментарии', 'all comments',
];
const ALL_COMMENTS = [
  'все комментарии', 'усі коментарі', 'all comments', 'todos los comentarios',
  'todos os comentários', 'alle kommentare', 'tous les commentaires', 'tutti i commenti',
  'wszystkie komentarze', 'tüm yorumlar',
];

// FB автоплеит видео в посте (нередко со звуком) при открытии — мьютим и ставим
// на паузу. Повторяем несколько раз: плеер может перезапуститься после догрузки.
async function silenceVideos(page, log, rounds = 3) {
  let paused = 0;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const n = await page.evaluate(() => {
      let count = 0;
      for (const v of document.querySelectorAll('video')) {
        try {
          v.muted = true; v.volume = 0; v.autoplay = false;
          v.removeAttribute('autoplay');
          if (!v.paused) { v.pause(); count += 1; }
        } catch { /* ignore */ }
      }
      return count;
    }).catch(() => 0);
    paused += n;
    // eslint-disable-next-line no-await-in-loop
    if (i < rounds - 1) await sleep(500);
  }
  if (paused > 0) log.info(`[FB Bot] Видео в посте заглушено/остановлено (${paused}).`);
}

// Переключить сортировку комментов на «Все комментарии», чтобы видеть все (в т.ч.
// только что оставленную родительскую реплику). Тихо пропускаем, если не нашли.
async function switchToAllComments(page, log) {
  // 1) Триггер сортировки («Самые актуальные ▾») ищем ТОЛЬКО в модалке поста и
  // жмём РЕАЛЬНОЙ мышью — DOM .click() по внутреннему span у FB не открывает меню.
  const trigCoords = await page.evaluate((triggers) => {
    const low = (s) => (s || '').trim().toLowerCase();
    const root = (() => {
      for (const d of document.querySelectorAll('div[role="dialog"]')) {
        const r = d.getBoundingClientRect();
        if (r.width > 300 && r.height > 300) return d;
      }
      return document;
    })();
    let hit = null;
    for (const el of root.querySelectorAll('[role="button"], span, div')) {
      const t = low(el.innerText || el.textContent);
      // Короткий текст, начинающийся с подписи сортировки (без описаний-тултипов).
      if (t && t.length < 26 && triggers.some((w) => t === w || t.startsWith(w))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { hit = el; break; }
      }
    }
    if (!hit) return null;
    let btn = hit;
    for (let up = 0; up < 6 && btn.parentElement; up += 1) {
      if (btn.getAttribute && btn.getAttribute('role') === 'button') break;
      btn = btn.parentElement;
    }
    (btn || hit).scrollIntoView({ block: 'center' });
    const r = (btn || hit).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, SORT_TRIGGER).catch(() => null);
  if (!trigCoords) { log.info('[FB Bot] Триггер сортировки комментов не найден — оставляю как есть.'); return false; }
  await page.mouse.click(trigCoords.x, trigCoords.y).catch(() => {});
  log.info('[FB Bot] Открываю меню сортировки комментов…');

  // 2) Ждём появления пункта «Все комментарии» (портал в document) и жмём по его
  // СТРОКЕ реальной мышью. Опрос до ~4с, т.к. меню отрисовывается не мгновенно.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const coords = await page.evaluate((opts) => {
      const low = (s) => (s || '').trim().toLowerCase();
      let titleEl = null;
      for (const el of document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menu"] span, [role="menu"] div, span, div')) {
        const t = low(el.innerText || el.textContent);
        if (!t) continue;
        // Точная подпись пункта, либо «заголовок + короткое описание» одним узлом.
        if (opts.includes(t) || opts.some((w) => t.startsWith(w) && t.length < w.length + 70)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { titleEl = el; break; }
        }
      }
      if (!titleEl) return null;
      let row = titleEl;
      for (let up = 0; up < 6 && row.parentElement; up += 1) {
        const role = row.getAttribute && row.getAttribute('role');
        if (role === 'menuitem' || role === 'menuitemradio' || role === 'button') break;
        row = row.parentElement;
      }
      (row || titleEl).scrollIntoView({ block: 'center' });
      const r = (row || titleEl).getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 90), y: r.top + r.height / 2 };
    }, ALL_COMMENTS).catch(() => null);
    if (coords) {
      await page.mouse.click(coords.x, coords.y).catch(() => {});
      log.info('[FB Bot] Сортировка комментов → «Все комментарии».');
      await sleep(rand(1500, 2500));
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
  }
  log.info('[FB Bot] Пункт «Все комментарии» в меню не найден.');
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

// Найти комментарий по тексту (для режима ответа). Ищет контейнер role="article",
// подгружает комменты («показать ещё» + скролл). Возвращает ElementHandle или null.
async function findCommentByText(page, text, timeoutMs) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const snippet = norm(text).slice(0, 50);
  if (snippet.length < 3) return null;
  const deadline = Date.now() + Math.max(timeoutMs, 22000);
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const handle = await page.evaluateHandle((snip) => {
      const n = (s) => (s || '').replace(/\s+/g, ' ');
      // Ищем ТОЛЬКО внутри модалки поста (если открыта), а не по всей странице —
      // иначе цепляли ленту за модалкой.
      const root = (() => {
        for (const d of document.querySelectorAll('div[role="dialog"]')) {
          const r = d.getBoundingClientRect();
          if (r.width > 300 && r.height > 300) return d;
        }
        return document;
      })();
      // Берём САМЫЙ УЗКИЙ article, содержащий фразу (наименьший по тексту) — это
      // конкретный коммент. Внешний/родительский article содержит текст всех
      // вложенных ответов, поэтому по «первому совпадению» цеплялся не тот.
      let best = null; let bestLen = Infinity;
      for (const a of root.querySelectorAll('div[role="article"]')) {
        const txt = n(a.textContent);
        if (txt.includes(snip) && txt.length < bestLen) { best = a; bestLen = txt.length; }
      }
      if (best) return best;
      // Запас: любой текстовый узел → поднимаемся к article.
      for (const el of root.querySelectorAll('div[dir="auto"], span')) {
        if (n(el.textContent).includes(snip)) {
          let c = el;
          for (let up = 0; up < 12 && c; up += 1) {
            if (c.getAttribute && c.getAttribute('role') === 'article') return c;
            c = c.parentElement;
          }
          return el;
        }
      }
      return null;
    }, snippet);
    const el = handle.asElement();
    if (el) {
      // eslint-disable-next-line no-await-in-loop
      const box = await el.boundingBox().catch(() => null);
      if (box && box.height > 0) return el;
    }
    // Подгрузить ещё комменты: клик по «показать больше комментариев» + скролл.
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(() => {
      const low = (s) => (s || '').toLowerCase();
      const root = (() => {
        for (const d of document.querySelectorAll('div[role="dialog"]')) {
          const r = d.getBoundingClientRect();
          if (r.width > 300 && r.height > 300) return d;
        }
        return document;
      })();
      // «Показать ещё комментарии» — мультиязычно.
      const moreComments = [
        'more comment', 'view more', 'previous comment', 'view previous',
        'больше комментар', 'ещё комментар', 'еще комментар', 'предыдущие коммент',
        'переглянути ще', 'більше комент', 'ще комент', 'попередні комент',
        'más comentario', 'ver más comentario', 'mais comentário', 'comentários anteriores', 'ver mais',
        'weitere kommentar', 'mehr kommentar', 'plus de commentaire', 'commentaires précédents',
        'altri commenti', 'więcej komentarzy', 'meer reacties', 'daha fazla yorum', 'önceki yorum',
      ];
      // Развернуть свёрнутые ответы: слово-ответ + ЦИФРА (чтобы не нажать «Ответить»).
      const replyWords = ['repl', 'відповід', 'ответ', 'respuesta', 'resposta', 'antwort', 'réponse', 'rispost', 'odpowied', 'yanıt', 'reactie'];
      for (const b of root.querySelectorAll('[role="button"], span, a')) {
        const t = low(b.innerText || b.textContent);
        if (!t || t.length > 45) continue;
        const isMore = moreComments.some((r) => t.includes(r));
        const isRepl = /\d/.test(t) && replyWords.some((r) => t.includes(r));
        if (isMore || isRepl) { b.scrollIntoView({ block: 'center' }); b.click(); return; }
      }
    }).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await scrollPostArea(page);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(800);
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
  // Playwright-клик (сам скроллит в зону видимости и жмёт по центру) — надёжнее
  // клика по вычисленным координатам, который мог промахнуться и не открыть бокс.
  try {
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click({ timeout: 6000 });
  } catch {
    try { await humanClick(page, b); } catch { return false; }
  }
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

// Дождаться именно РЕПЛАЙ-БОКСА после клика «Ответить». Сначала — поле в фокусе
// (FB обычно сразу фокусирует ответ), затем — редактируемое поле РЯДОМ с этим же
// комментарием (реплай-бокс появляется вложенно под ним). НЕ возвращает верхний
// композер страницы — иначе улетел бы топ-коммент вместо ответа.
// Найти НОВОЕ редактируемое поле, появившееся после клика «Ответить» = reply-бокс.
// Существующие поля (в т.ч. главный композер) заранее помечаются data-pre-reply,
// поэтому берём то, что БЕЗ этой метки. FB не всегда фокусирует reply-бокс сам,
// так что ищем по DOM, а не по фокусу.
async function findNewEditable(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const h = await page.evaluateHandle(() => {
      const els = document.querySelectorAll('[contenteditable="true"], [role="textbox"]');
      for (const el of els) {
        if (el.hasAttribute('data-pre-reply')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 5) return el;
      }
      return null;
    });
    const el = h.asElement();
    if (el) return el;
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
  }
  return null;
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

// Честная проверка публикации: реально ищем НАШ текст среди комментов на посте.
// Берём устойчивый фрагмент начала текста (хвост варьируется уникализатором).
// FB часто чистит поле, но коммент придерживает как спам — поле «очистилось» ≠
// «опубликовано». Скроллим и ждём, т.к. коммент подгружается не мгновенно.
async function verifyCommentPosted(page, text, log, timeoutMs = 16000) {
  // Чистим от эмодзи/пунктуации: FB рисует эмодзи картинками, они НЕ попадают в
  // textContent, и строгое совпадение ломалось (хвост-эмодзи уникализатора не
  // находился). Берём короткое «ядро» из букв/цифр начала текста.
  const clean = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, '').trim();
  const snippet = clean(text).slice(0, 30);
  if (snippet.length < 6) return true; // слишком короткий текст — не проверяем
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const found = await page.evaluate((snip) => {
      const clean2 = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, '').trim();
      // Ищем внутри модалки поста (если открыта), не по всей странице.
      const root = (() => {
        for (const d of document.querySelectorAll('div[role="dialog"]')) {
          const r = d.getBoundingClientRect();
          if (r.width > 300 && r.height > 300) return d;
        }
        return document;
      })();
      // Только внутри комментов (article), НЕ в поле ввода — иначе оставшийся
      // черновик дал бы ложное «подтверждено».
      for (const n of root.querySelectorAll('div[role="article"]')) {
        if (clean2(n.textContent || '').includes(snip)) return true;
      }
      return false;
    }, snippet);
    if (found) return true;
    // eslint-disable-next-line no-await-in-loop
    await scrollPostArea(page);
    // eslint-disable-next-line no-await-in-loop
    await sleep(rand(900, 1500));
  }
  return false;
}

async function leaveFacebookComment(payload, log, handle = {}) {
  const {
    profileUuid, postUrl, commentText, imagePath, replyToText,
  } = payload;
  let connection;
  // Если задачу отменили — прерываемся с понятной ошибкой (её поймает очередь).
  const ensureLive = () => { if (handle.canceled) throw new Error('Операция отменена пользователем'); };

  try {
    connection = await connectToOcto(profileUuid, log, { forceRestart: true });
    handle.browser = connection.browser; // чтобы очередь могла закрыть сессию при отмене
    const { page } = connection;

    // Стабильная «персона» профиля: один и тот же профиль Octo ведёт себя
    // одинаково от запуска к запуску (темп печати, скорость мыши, привычки).
    page.__persona = createPersona(profileUuid);
    log.info(`[FB Bot] Персона профиля: mouseSpeed=${page.__persona.mouseSpeed.toFixed(2)}, typeBase=${Math.round(page.__persona.typeBase)}ms, typo=${(page.__persona.typoRate * 100).toFixed(1)}%, button=${(page.__persona.prefersButton * 100).toFixed(0)}%`);

    ensureLive();
    log.info(`[FB Bot] Переход на пост: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeout });
    await silenceVideos(page, log);

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
    // Пост удалён/недоступен/требует логин — валим сразу с ПРАВДИВОЙ причиной,
    // не тратя время на поиск поля (которого и не будет).
    const early = await diagnosePostProblem(page);
    if (early.hard) {
      log.info(`[FB Bot] ${early.reason}.`);
      throw new Error(`${early.reason.charAt(0).toUpperCase()}${early.reason.slice(1)}.`);
    }

    // Пост-пермалинк часто открывается в модальном окне. Если оно есть — курсор
    // и скролл должны быть ВНУТРИ него, иначе крутим фон, а комментарии не грузятся.
    const dialog = await getDialog(page);
    await silenceVideos(page, log, 2);
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
      // Включаем «Все комментарии», иначе свежая родительская реплика может не
      // показаться в «Самые актуальные».
      await switchToAllComments(page, log);
      const target = await findCommentByText(page, replyToText, config.selectorTimeout);
      if (!target) {
        const why = await diagnosePostProblem(page);
        if (why.reason) throw new Error(`${why.reason.charAt(0).toUpperCase()}${why.reason.slice(1)} — ответ поставить не на что.`);
        throw new Error(`Не найден комментарий для ответа: "${replyToText.slice(0, 40)}…" (родитель ещё не опубликован или скрыт сортировкой).`);
      }
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(rand(500, 1200));
      ensureLive();
      // Метим существующие редактируемые поля — чтобы после «Ответить» отличить
      // НОВОЕ (reply-бокс) от главного композера.
      await page.evaluate(() => {
        document.querySelectorAll('[contenteditable="true"], [role="textbox"]')
          .forEach((el) => el.setAttribute('data-pre-reply', '1'));
      }).catch(() => {});
      const clicked = await clickReply(page, target, log);
      if (!clicked) throw new Error('Не найдена кнопка «Ответить» у комментария');
      await sleep(rand(1000, 1800));
      // Берём ИМЕННО новый reply-бокс (не главный композер).
      commentBox = await findNewEditable(page, 10000);
      if (!commentBox) throw new Error('Не открылось поле ответа (reply-box) — как ответ коммент не отправлен.');
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
        // Поле не найдено и detectBlock ничего не увидел — проверим статус
        // аккаунта. Бан/проверка → помечаем профиль (e.accountStatus подхватит
        // очередь). Если аккаунт живой — комменты на посте отключены, профиль ок.
        const st = await detectAccountStatus(page);
        if (st !== 'ok') {
          const e = new Error(`Аккаунт требует внимания (${st}) — поле комментария недоступно.`);
          e.accountStatus = st;
          throw e;
        }
        const why = await diagnosePostProblem(page);
        if (why.reason) throw new Error(`${why.reason.charAt(0).toUpperCase()}${why.reason.slice(1)}.`);
        throw new Error('Поле для комментария не найдено (возможно, изменилась вёрстка FB или комментарии отключены).');
      }
    }

    ensureLive();
    if (replyToText) {
      // РЕЖИМ ОТВЕТА: commentBox — это НОВЫЙ reply-бокс (не главный композер).
      // Кликаем ИМЕННО по нему и печатаем. Без scrollIntoView — он и так виден
      // рядом с комментом, а лишний скролл может закрыть инлайн-ответ.
      log.info('[FB Bot] Кликаю по reply-боксу и печатаю ответ...');
      await humanClick(page, commentBox);
      await sleep(rand(300, 700));
    } else {
      // Довести поле в зону видимости и «дочитать» перед кликом.
      await commentBox.scrollIntoViewIfNeeded();
      await sleep(rand(500, 1200));
      ensureLive();
      log.info('[FB Bot] Навожу курсор и кликаю по полю...');
      await humanClick(page, commentBox);
      await sleep(rand(400, 1000));
      log.info('[FB Bot] Печатаю текст как человек...');
    }
    ensureLive();
    await humanType(page, commentText);
    // Контроль: текст реально в поле? Если фокус слетел — перепечатать и обновить
    // хэндл поля (для reply — новый reply-бокс, для топ-коммента — главный композер).
    commentBox = await ensureTextInField(
      page, commentBox, commentText, log,
      replyToText ? () => findNewEditable(page, 4000) : () => findCommentBox(page, 3000),
    );

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

    await submitComment(page, commentBox, log);
    await sleep(rand(3500, 6000));

    // Поле очистилось — это лишь косвенный признак. Честная проверка ниже.
    let fieldCleared = false;
    try {
      const leftover = (await commentBox.innerText().catch(() => '')).trim();
      fieldCleared = leftover.length === 0;
    } catch {
      fieldCleared = true; // поле пропало из DOM
    }

    // ЧЕСТНАЯ ПРОВЕРКА публикации — и для топ-комментов (реж.1/2), и для ОТВЕТОВ
    // (реж.3). Реально ищем наш текст среди комментов на посте (в модалке, с
    // очисткой от эмодзи). Не нашли — FB придержал/не опубликовал.
    const kind = replyToText ? 'Ответ' : 'Коммент';
    log.info(`[FB Bot] Проверяю, появился ли ${replyToText ? 'ответ' : 'коммент'} на посте...`);
    const confirmed = await verifyCommentPosted(page, commentText, log);
    if (!confirmed) {
      throw new Error(`${kind} не подтверждён: не найден на посте (вероятно, FB придержал как спам). Проверьте вручную.`);
    }
    log.info(`[FB Bot] ${kind} подтверждён на посте${fieldCleared ? '' : ' (поле не очистилось, но текст есть)'}. Профиль ${profileUuid}`);

    // Захват реальной FB-идентичности (id из c_user, имя из страницы) — для
    // белого списка. Сессия сейчас гарантированно валидна и на FB-странице.
    let identity = { fbId: '', fbName: '' };
    try {
      identity = await readFbIdentity(page);
      if (identity.fbId || identity.fbName) {
        log.info(`[FB Bot] FB-идентичность: id=${identity.fbId || '—'}, имя=${identity.fbName || '—'}`);
      }
    } catch (e) {
      log.warn(`[FB Bot] Не удалось прочитать FB-идентичность: ${e.message}`);
    }
    return identity;
  } finally {
    // Останавливаем только если МЫ его открыли (connection есть). Если старт
    // упал с «already started» — в профиле работает человек, не трогаем.
    if (connection && profileUuid) await disconnectOcto(profileUuid, log);
    // Картинку НЕ удаляем — она нужна для истории/просмотра (раздаётся статикой).
  }
}

module.exports = { leaveFacebookComment };
