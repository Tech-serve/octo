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
async function readFbIdentity(page) {
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

  return out;
}

// Определить состояние аккаунта по открытой FB-странице. Возвращает код:
// 'ok' | 'checkpoint' | 'disabled' | 'logout'. Опирается прежде всего на URL
// (язык-независимо), плюс запасные признаки: капча и текст «аккаунт отключён».
async function detectAccountStatus(page) {
  const url = page.url();
  if (/\/checkpoint\//i.test(url)) return 'checkpoint';
  if (/two_step_verification|\/recover\/|\/confirmemail/i.test(url)) return 'checkpoint';
  if (/\/disabled(\/|\b)/i.test(url)) return 'disabled';
  if (/\/login/i.test(url)) return 'logout';

  try {
    const captcha = await page.$(
      'iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], '
      + 'iframe[title*="captcha" i], div[id*="captcha" i], img[src*="captcha" i]',
    );
    if (captcha) return 'checkpoint';
  } catch { /* ignore */ }

  try {
    const body = (await page.evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 4000))).toLowerCase();
    const disabledPhrases = [
      'account has been disabled', 'your account has been disabled', 'account is disabled',
      'ваш аккаунт отключ', 'ваш акаунт вимкнено', 'обліковий запис вимкнено',
    ];
    if (disabledPhrases.some((p) => body.includes(p))) return 'disabled';
  } catch { /* ignore */ }

  return 'ok';
}

async function connectToOcto(profileUuid, log) {
  log.info(`[Octo] Запуск профиля ${profileUuid}...`);
  let response;
  try {
    response = await axios.post(`${OCTO_LOCAL_API}/start`, {
      uuid: profileUuid,
      headless: config.headless,
      debug_port: true,
    });
  } catch (e) {
    // Достаём реальную причину из тела ответа Octo (msg/error/message), а не
    // просто «status code 400» — так видно, что именно не так (лимит/прокси/…).
    const body = e.response && e.response.data;
    let detail = e.message;
    if (body) detail = body.msg || body.error || body.message || (typeof body === 'string' ? body : JSON.stringify(body));
    const err = new Error(`Octo отказал в запуске: ${detail}`);
    err.octoStatus = e.response && e.response.status;
    throw err;
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
  const page = context.pages()[0] || (await context.newPage());

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
