const axios = require('axios');
const { chromium } = require('playwright');
const config = require('./config');

const OCTO_LOCAL_API = config.octoApi;

// Расширения/потоки видео (и его аудиодорожек). ВАЖНО: .webp — это картинка,
// её НЕ блокируем; .webm — видео, блокируем. FB отдаёт видео сегментами с
// .mp4/.m4s в URL (часто с byte-range в query), поэтому матчим до ? или #.
const VIDEO_RE = /\.(mp4|m4s|m4v|m4a|webm|mov|m3u8|mpd|ts|f4v|flv)(?:[?#]|$)/i;

// Блокировка ТОЛЬКО видео: обрываем медиа-ресурсы и видео-сегменты, всё
// остальное (в т.ч. картинки, API, скрипты) пропускаем. Экономит RAM/CPU/трафик.
async function applyVideoBlocking(context, log) {
  await context.route('**/*', (route) => {
    try {
      const req = route.request();
      if (req.resourceType() === 'media' || VIDEO_RE.test(req.url())) {
        return route.abort();
      }
      return route.continue();
    } catch {
      try { return route.continue(); } catch { return undefined; }
    }
  });
  log.info('[Octo] Блокировка видео включена (картинки грузятся).');
}

// Теги профиля могут приходить как массив строк или объектов {name}/{title}.
function extractTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === 'string' ? t : (t && (t.name || t.title)) || null))
    .filter(Boolean);
}

// Получить ВСЕ профили из облачного API Octo, проходя по всем страницам.
// Возвращает [{ uuid, title, tags: [] }]. Нужен API-токен.
async function listProfiles() {
  if (!config.octoApiToken) {
    const err = new Error('Не задан OCTO_API_TOKEN — список профилей недоступен. Введите UUID вручную.');
    err.code = 'NO_TOKEN';
    throw err;
  }
  const pageLen = 100;
  const maxPages = 500; // предохранитель (до 50 000 профилей)
  const headers = { 'X-Octo-Api-Token': config.octoApiToken };
  const all = [];

  for (let page = 0; page < maxPages; page++) {
    const url = `${config.octoCloudApi}/profiles?page_len=${pageLen}&page=${page}&fields=title,tags`;
    // eslint-disable-next-line no-await-in-loop
    const response = await axios.get(url, { headers, timeout: 20000 });

    const body = response.data;
    const raw = Array.isArray(body) ? body : (body.data || body.profiles || []);
    if (!raw.length) break;

    for (const p of raw) {
      if (!p || !p.uuid) continue;
      all.push({
        uuid: p.uuid,
        title: p.title || p.name || p.uuid,
        tags: extractTags(p.tags),
      });
    }

    if (raw.length < pageLen) break; // последняя страница
  }

  return all;
}

// Прочитать реальную FB-идентичность залогиненного профиля прямо из открытой
// страницы: id — из куки c_user (надёжно), имя — из CurrentUserInitialData,
// которую FB встраивает в inline-скрипты. Навигация не нужна — читаем с текущей
// FB-страницы. Возвращает { fbId, fbName } (любое поле может быть пустым).
async function readFbIdentity(page, opts = {}) {
  const out = { fbId: '', fbName: '' };
  try {
    const cookies = await page.context().cookies('https://www.facebook.com');
    const cu = cookies.find((c) => c.name === 'c_user');
    if (cu && cu.value) out.fbId = cu.value;
  } catch { /* нет доступа к кукам — id останется пустым */ }

  try {
    const parsed = await page.evaluate(() => {
      const decode = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
      for (const sc of Array.from(document.scripts)) {
        const t = sc.textContent || '';
        if (!t.includes('CurrentUserInitialData')) continue;
        const idm = t.match(/"USER_ID":"(\d+)"/);
        const nm = t.match(/"NAME":"((?:[^"\\]|\\.)*)"/);
        return { id: idm ? idm[1] : '', name: nm ? decode(nm[1]) : '' };
      }
      return { id: '', name: '' };
    });
    if (parsed) {
      if (!out.fbId && parsed.id) out.fbId = parsed.id;
      if (parsed.name) out.fbName = parsed.name;
    }
  } catch { /* скрипт не найден — имя останется пустым */ }

  // Запасной способ (только для проверочного прогона): если имя не считалось —
  // зайти на свой профиль и взять его из og:title/title. Медленнее (навигация),
  // поэтому обычная простановка коммента это не вызывает.
  if (opts.deep && !out.fbName) {
    try {
      await page.goto('https://www.facebook.com/me/', { waitUntil: 'domcontentloaded', timeout: config.navTimeout });
      await page.waitForTimeout(1200);
      const name = await page.evaluate(() => {
        const og = document.querySelector('meta[property="og:title"]');
        if (og && og.content) return og.content.trim();
        const t = (document.title || '').replace(/\s*[|·—-]\s*Facebook.*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
        return t && !/^facebook$/i.test(t) ? t : '';
      });
      if (name) out.fbName = name;
      if (!out.fbId) {
        const cookies = await page.context().cookies('https://www.facebook.com');
        const cu = cookies.find((c) => c.name === 'c_user');
        if (cu && cu.value) out.fbId = cu.value;
      }
    } catch { /* профиль не открылся — имя останется пустым */ }
  }

  return out;
}

// Определить состояние аккаунта по открытой FB-странице. Возвращает код:
// 'ok' | 'checkpoint' | 'disabled' | 'logout'. Опирается прежде всего на URL
// (язык-независимо), плюс запасные признаки: капча и текст «аккаунт отключён».
async function detectAccountStatus(page) {
  const url = page.url();
  let body = '';
  try {
    body = (await page.evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 6000))).toLowerCase();
  } catch { /* тело недоступно */ }
  const has = (arr) => arr.some((p) => body.includes(p));

  // 1) Бан/приостановка. Сильнее checkpoint: FB иногда показывает это тоже под
  //    /checkpoint, поэтому решаем по тексту. Страница на языке аккаунта —
  //    держим фразы по основным гео (ru/uk/en/es/pt/de/fr/it/pl/nl/tr).
  const banPhrases = [
    // ru/uk
    'приостановили ваш аккаунт', 'мы приостановили', 'аккаунт приостановлен',
    'обжаловать наше решение', 'будет отключ', 'ваш аккаунт отключ', 'ваш аккаунт заблокирован',
    'ми призупинили', 'обліковий запис вимкнено', 'ваш акаунт вимкнено', 'оскаржити',
    // en
    'we suspended your account', 'your account has been suspended', 'account has been suspended',
    'account has been disabled', 'your account is disabled', 'we disabled your account',
    'we\'ve suspended your account', 'to disagree with the decision', 'disagree with our decision',
    // es
    'suspendimos tu cuenta', 'tu cuenta ha sido suspendida', 'hemos inhabilitado tu cuenta',
    'tu cuenta ha sido inhabilitada', 'apelar',
    // pt
    'suspendemos sua conta', 'sua conta foi suspensa', 'desativamos sua conta',
    'sua conta foi desativada', 'recorrer',
    // de
    'wir haben dein konto gesperrt', 'dein konto wurde gesperrt', 'dein konto wurde deaktiviert',
    'einspruch',
    // fr
    'nous avons suspendu votre compte', 'votre compte a été suspendu', 'votre compte a été désactivé',
    'faire appel',
    // it
    'abbiamo sospeso il tuo account', 'il tuo account è stato sospeso', 'il tuo account è stato disabilitato',
    'presentare ricorso',
    // pl
    'zawiesiliśmy twoje konto', 'twoje konto zostało wyłączone', 'odwołać',
    // nl
    'we hebben je account opgeschort', 'je account is uitgeschakeld', 'bezwaar maken',
    // tr
    'hesabını askıya aldık', 'hesabın devre dışı bırakıldı', 'itiraz et',
    // best-effort для не-латиницы (jp/kr/ar/he) — конкретные строки, без ложных срабатываний
    'アカウントを停止', 'アカウントを無効', '계정이 정지', '계정이 비활성화',
    'تم تعطيل حسابك', 'تم تعليق حسابك', 'החשבון שלך הושבת', 'השבתנו את החשבון',
  ];
  if (/\/disabled(\/|\b)/i.test(url) || has(banPhrases)) return 'disabled';

  // 2) Верификация/подтверждение личности → checkpoint. URL /checkpoint —
  //    язык-независимый признак, ловит любую верификацию (в т.ч. видеоселфи).
  //    Тексты — вспомогательно, на случай верификации вне /checkpoint.
  const verifyPhrases = [
    // ru/uk
    'подтвердите личность', 'подтвердите свою личность', 'видеоселфи', 'видеоселфі',
    'подтвердите, что это ваш аккаунт', 'подтвердите, что это вы', 'підтвердьте',
    // en
    'confirm your identity', 'verify your identity', 'video selfie', 'security check',
    'confirm it\'s you', 'we need to confirm',
    // es/pt
    'confirma tu identidad', 'verifica tu identidad', 'confirme sua identidade', 'verifique sua identidade',
    'selfie de vídeo', 'selfie de video',
    // de/fr/it
    'bestätige deine identität', 'identität bestätigen', 'confirmez votre identité', 'vérifiez votre identité',
    'conferma la tua identità', 'verifica la tua identità', 'video-selfie', 'selfie vidéo',
    // pl/nl/tr
    'potwierdź swoją tożsamość', 'zweryfikuj', 'bevestig je identiteit', 'kimliğini doğrula',
  ];
  if (/\/checkpoint\//i.test(url)) return 'checkpoint';
  if (/two_step_verification|\/recover\/|\/confirmemail/i.test(url)) return 'checkpoint';
  if (has(verifyPhrases)) return 'checkpoint';

  // 3) Разлогин.
  if (/\/login/i.test(url)) return 'logout';

  // 4) Капча.
  try {
    const captcha = await page.$(
      'iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], '
      + 'iframe[title*="captcha" i], div[id*="captcha" i], img[src*="captcha" i]',
    );
    if (captcha) return 'checkpoint';
  } catch { /* ignore */ }

  return 'ok';
}

async function connectToOcto(profileUuid, log, opts = {}) {
  log.info(`[Octo] Запуск профиля ${profileUuid}...`);

  const startProfile = () => axios.post(`${OCTO_LOCAL_API}/start`, {
    uuid: profileUuid,
    headless: config.headless,
    debug_port: true,
  });
  // Достаём реальную причину из тела ответа Octo (msg/error/message).
  const octoDetail = (e) => {
    const body = e.response && e.response.data;
    if (body) return body.msg || body.error || body.message || (typeof body === 'string' ? body : JSON.stringify(body));
    return e.message;
  };

  let response;
  try {
    response = await startProfile();
  } catch (e) {
    const detail = octoDetail(e);
    // Для постинга (forceRestart) зависший открытым профиль ГАСИМ и стартуем
    // заново — иначе задача падает. Массовая проверка forceRestart НЕ передаёт,
    // поэтому там чужие открытые профили остаются в покое.
    if (opts.forceRestart && /already started|уже запущ/i.test(detail)) {
      log.info('[Octo] Профиль уже запущен — принудительно закрываю и запускаю заново...');
      let lastErr = e;
      for (const waitMs of [2000, 5000]) {
        try { await axios.post(`${OCTO_LOCAL_API}/stop`, { uuid: profileUuid }); } catch { /* ignore */ }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, waitMs));
        try {
          // eslint-disable-next-line no-await-in-loop
          response = await startProfile();
          lastErr = null;
          break;
        } catch (e2) { lastErr = e2; }
      }
      if (lastErr) {
        const err = new Error(`Octo отказал в запуске (после принудительного рестарта): ${octoDetail(lastErr)}`);
        err.octoStatus = lastErr.response && lastErr.response.status;
        throw err;
      }
    } else {
      const err = new Error(`Octo отказал в запуске: ${detail}`);
      err.octoStatus = e.response && e.response.status;
      throw err;
    }
  }

  // Octo возвращает поле ws_endpoint (оставляем ws как запасной вариант для совместимости)
  const wsEndpoint = response.data.ws_endpoint || response.data.ws;
  if (!wsEndpoint) {
    throw new Error('Octo не вернул ws_endpoint (проверьте, что Octo Browser запущен и UUID верный)');
  }
  log.info('[Octo] Профиль запущен. Подключаем Playwright...');

  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: config.cdpConnectTimeoutMs });
  const contexts = browser.contexts();
  const context = contexts[0] || (await browser.newContext());

  // Профиль Octo часто открывает кучу вкладок (сохранённая сессия) — они грузятся,
  // едят ресурсы и тормозят старт. Оставляем ОДНУ вкладку для работы, остальные
  // закрываем, чтобы не ждать их прогрузку.
  const openPages = context.pages();
  const page = openPages[0] || (await context.newPage());
  for (const p of openPages) {
    if (p === page) continue;
    // eslint-disable-next-line no-await-in-loop
    try { await p.close({ runBeforeUnload: false }); } catch { /* ignore */ }
  }
  if (openPages.length > 1) log.info(`[Octo] Закрыл лишние вкладки: было ${openPages.length}, оставил 1.`);

  // Блокируем видео до навигации, чтобы автоплей-ролики не грузились вовсе.
  if (config.blockVideo) {
    try {
      await applyVideoBlocking(context, log);
    } catch (e) {
      log.warn(`[Octo] Не удалось включить блокировку видео: ${e.message}`);
    }
  }

  return { browser, page };
}

async function disconnectOcto(profileUuid, log) {
  try {
    log.info(`[Octo] Закрытие профиля ${profileUuid}...`);
    await axios.post(`${OCTO_LOCAL_API}/stop`, { uuid: profileUuid });
  } catch (err) {
    log.warn(`[Octo] Не удалось корректно остановить профиль: ${err.message}`);
  }
}

module.exports = {
  connectToOcto, disconnectOcto, listProfiles, readFbIdentity, detectAccountStatus,
};
