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

// Имя аккаунта на FB берём из описания профиля Octo (формат "почта | пароль [Имя]").
// Берём текст в квадратных скобках. Это же имя = запись в белом списке.
// Ищем сначала в явных полях описания, затем в любом строковом поле профиля
// (на случай если API называет поле иначе).
function parseFbName(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const pick = (s) => {
    if (typeof s !== 'string') return '';
    const m = s.match(/\[([^\]]+)\]/);
    return m ? m[1].trim() : '';
  };
  const direct = pick(profile.description) || pick(profile.notes) || pick(profile.note);
  if (direct) return direct;
  for (const v of Object.values(profile)) {
    const got = pick(v);
    if (got) return got;
  }
  return '';
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
    // Без фильтра fields — Octo отдаёт полный профиль (включая описание/notes,
    // как бы поле ни называлось). Фильтр с неизвестным полем Octo отвергает.
    const url = `${config.octoCloudApi}/profiles?page_len=${pageLen}&page=${page}`;
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
        fbName: parseFbName(p),
      });
    }

    if (raw.length < pageLen) break; // последняя страница
  }

  return all;
}

async function connectToOcto(profileUuid, log) {
  log.info(`[Octo] Запуск профиля ${profileUuid}...`);
  const response = await axios.post(`${OCTO_LOCAL_API}/start`, {
    uuid: profileUuid,
    headless: config.headless,
    debug_port: true,
  });

  // Octo возвращает поле ws_endpoint (оставляем ws как запасной вариант для совместимости)
  const wsEndpoint = response.data.ws_endpoint || response.data.ws;
  if (!wsEndpoint) {
    throw new Error('Octo не вернул ws_endpoint (проверьте, что Octo Browser запущен и UUID верный)');
  }
  log.info('[Octo] Профиль запущен. Подключаем Playwright...');

  const browser = await chromium.connectOverCDP(wsEndpoint);
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

module.exports = { connectToOcto, disconnectOcto, listProfiles };
