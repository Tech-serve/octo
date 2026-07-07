// Разовый скрипт: проверить НЕпроверенные профили и обновить whitelist + статусы.
//
// Что делает:
//   • берёт все профили из Octo;
//   • отбирает: кого НЕТ в whitelist (нет имени) ИЛИ со статусом «ошибка»
//     (последние перепроверяет);
//   • открывает каждый, читает из FB имя+ID (пишет в whitelist) и статус
//     аккаунта: жив / checkpoint / бан / разлогин / ошибка (ставит пометку ⚠️);
//   • печатает итоговый список по категориям.
//
// Запуск (на сервере, из папки server):
//   node scripts/checkProfiles.js                  — все непроверенные
//   node scripts/checkProfiles.js --tag="Fakes | Sweeps"   — только с этим тегом
//   node scripts/checkProfiles.js --recheck        — + переоткрыть ВСЕ помеченные
//       (checkpoint/бан/прокси/разлогин) и переписать их актуальный статус
//   node scripts/checkProfiles.js --all            — проверить ВСЕХ заново
//   node scripts/checkProfiles.js --concurrency=10 — своё число параллельных

const config = require('../config');
const store = require('../taskStore');
const { logger } = require('../logger');
const {
  listProfiles, connectToOcto, disconnectOcto, readFbIdentity, detectAccountStatus,
} = require('../octoService');

const FB_URL = 'https://www.facebook.com/';

function parseArgs() {
  const out = {
    tag: null, all: false, recheck: false, concurrency: config.maxConcurrent,
  };
  for (const a of process.argv.slice(2)) {
    if (a === '--all') out.all = true;
    else if (a === '--recheck') out.recheck = true;
    else if (a.startsWith('--tag=')) out.tag = a.slice(6).replace(/^["']|["']$/g, '');
    else if (a.startsWith('--concurrency=')) {
      const n = parseInt(a.slice(14), 10);
      if (Number.isFinite(n) && n > 0) out.concurrency = n;
    }
  }
  return out;
}

async function checkOne(uuid) {
  let conn;
  try {
    conn = await connectToOcto(uuid, logger);
    const { page } = conn;
    await page.goto(FB_URL, { waitUntil: 'domcontentloaded', timeout: config.navTimeout });
    await page.waitForTimeout(1500);
    const ident = await readFbIdentity(page, { deep: true });
    if (ident.fbId || ident.fbName) store.upsertWhitelist(uuid, ident.fbId, ident.fbName);
    let acc = await detectAccountStatus(page);
    if (acc === 'ok' && !ident.fbId) acc = 'logout';
    if (acc === 'ok') store.clearProfileFlag(uuid); else store.flagProfile(uuid, acc);
    return { status: acc, name: ident.fbName, id: ident.fbId };
  } finally {
    // Закрываем только СВОЮ сессию. Если старт упал («already started» —
    // в профиле кто-то работает), conn нет — профиль не трогаем.
    if (conn) {
      try { if (conn.browser) await conn.browser.close().catch(() => {}); } catch { /* ignore */ }
      try { await disconnectOcto(uuid, logger); } catch { /* ignore */ }
    }
  }
}

async function main() {
  const args = parseArgs();
  const all = await listProfiles();
  const wl = store.listWhitelist();
  const flags = store.listFlags();

  // Берём профиль на проверку если:
  //  • он помечен технической ошибкой (error/proxy) — перепроверяем;
  //  • ИЛИ у него нет имени в whitelist (не открывали / имя не считалось),
  //    и при этом он НЕ в известном проблемном статусе (checkpoint/бан/разлогин —
  //    их не гоняем повторно, статус уже известен).
  const retryReasons = new Set(['error', 'proxy']);
  const needsCheck = (p) => {
    const flag = flags[p.uuid];
    // С --recheck переоткрываем ЛЮБОЙ помеченный (обновить/исправить статус).
    if (flag) return args.recheck ? true : retryReasons.has(flag.reason);
    const w = wl[p.uuid];
    return !w || !w.fbName;
  };

  let todo = all;
  if (!args.all) todo = todo.filter(needsCheck);
  if (args.tag) todo = todo.filter((p) => (p.tags || []).includes(args.tag));

  const noName = all.filter((p) => !wl[p.uuid] || !wl[p.uuid].fbName).length;
  const errCount = all.filter((p) => flags[p.uuid] && flags[p.uuid].reason === 'error').length;
  console.log(`Всего профилей: ${all.length}. Без имени (нет в whitelist): ${noName}, со статусом «ошибка»: ${errCount}. К проверке: ${todo.length}`);
  if (args.tag) console.log(`Фильтр по тегу: "${args.tag}"`);
  if (!todo.length) { console.log('Нечего проверять.'); process.exit(0); }

  // Классифицируем причину ошибки открытия по тексту исключения.
  //  proxy    — мёртвый/недоступный прокси профиля (нужен ремонт прокси);
  //  overload — перегруз: CDP-таймаут / браузер закрылся посреди работы (ретраится);
  //  octo     — Octo отказал в запуске (лимит/занят/перенесён — текст в скобках);
  //  error    — прочее.
  const classify = (msg) => {
    if (/SOCKS|PROXY|ERR_PROXY|ERR_SOCKS|ERR_TUNNEL|proxy data/i.test(msg)) return 'proxy';
    if (/connectOverCDP|Timeout \d+ms|has been closed|newPage|canceled by timeout|socket hang up|ECONNRESET/i.test(msg)) return 'overload';
    if (/already started/i.test(msg)) return 'inuse';
    if (/Octo отказал|status code|ws_endpoint/i.test(msg)) return 'octo';
    return 'error';
  };

  const concurrency = Math.max(1, args.concurrency);
  const results = {
    ok: [], checkpoint: [], disabled: [], logout: [],
    proxy: [], overload: [], octo: [], inuse: [], error: [],
  };
  let idx = 0;
  let done = 0;

  const next = async () => {
    while (idx < todo.length) {
      const p = todo[idx];
      idx += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await checkOne(p.uuid);
        (results[r.status] || results.error).push({ title: p.title, name: r.name });
      } catch (e) {
        const kind = classify(e.message || '');
        // Прокси — свой статус; технические — «ошибка»; «в работе» не метим вовсе.
        const reason = kind === 'proxy' ? 'proxy' : (kind === 'inuse' ? null : 'error');
        if (reason) { try { store.flagProfile(p.uuid, reason); } catch { /* ignore */ } }
        results[kind].push({ title: p.title, error: (e.message || '').replace(/\s+/g, ' ').slice(0, 120) });
      } finally {
        done += 1;
        process.stdout.write(`\r[${done}/${todo.length}] ${(p.title || '').slice(0, 40).padEnd(42)}`);
      }
    }
  };

  const workers = [];
  for (let i = 0; i < concurrency; i += 1) workers.push(next());
  await Promise.all(workers);

  const labels = {
    checkpoint: 'CHECKPOINT / требуют проверки (верификация)',
    disabled: 'БАН / приостановлен (обжалование)',
    logout: 'РАЗЛОГИН (сессия слетела)',
    proxy: 'ПРОКСИ мёртвый/недоступен (чинить прокси)',
    overload: 'ПЕРЕГРУЗ при старте (перепроверить, снизь --concurrency)',
    octo: 'OCTO ОТКАЗАЛ В ЗАПУСКЕ (см. причину)',
    inuse: 'В РАБОТЕ (профиль открыт кем-то — пропущен)',
    error: 'ПРОЧЕЕ (перепроверить)',
  };
  console.log('\n\n===== ИТОГ =====');
  console.log(`Живых: ${results.ok.length}`);
  for (const key of ['checkpoint', 'disabled', 'logout', 'proxy', 'overload', 'octo', 'inuse', 'error']) {
    const list = results[key];
    if (!list.length) continue;
    console.log(`\n${labels[key]}: ${list.length}`);
    for (const it of list) console.log(`  - ${it.title}${it.error ? `  (${it.error})` : ''}`);
  }
  console.log('\nWhitelist обновлён, пометки проставлены.');
  process.exit(0);
}

main().catch((e) => { console.error('Сбой скрипта:', e); process.exit(1); });
