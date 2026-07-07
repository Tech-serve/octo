// Разовый скрипт: проверить НЕпроверенные профили и обновить whitelist + статусы.
//
// Что делает:
//   • берёт все профили из Octo;
//   • отбирает «непроверенные» — те, кого ещё нет в whitelist и без пометки
//     (профили со статусом «ошибка» перепроверяет);
//   • открывает каждый, читает из FB имя+ID (пишет в whitelist) и статус
//     аккаунта: жив / checkpoint / бан / разлогин / ошибка (ставит пометку ⚠️);
//   • печатает итоговый список по категориям.
//
// Запуск (на сервере, из папки server):
//   node scripts/checkProfiles.js                  — все непроверенные
//   node scripts/checkProfiles.js --tag="Fakes | Sweeps"   — только с этим тегом
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
  const out = { tag: null, all: false, concurrency: config.maxConcurrent };
  for (const a of process.argv.slice(2)) {
    if (a === '--all') out.all = true;
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
    const ident = await readFbIdentity(page);
    if (ident.fbId || ident.fbName) store.upsertWhitelist(uuid, ident.fbId, ident.fbName);
    let acc = await detectAccountStatus(page);
    if (acc === 'ok' && !ident.fbId) acc = 'logout';
    if (acc === 'ok') store.clearProfileFlag(uuid); else store.flagProfile(uuid, acc);
    return { status: acc, name: ident.fbName, id: ident.fbId };
  } finally {
    try { if (conn && conn.browser) await conn.browser.close().catch(() => {}); } catch { /* ignore */ }
    try { await disconnectOcto(uuid, logger); } catch { /* ignore */ }
  }
}

async function main() {
  const args = parseArgs();
  const all = await listProfiles();
  const wl = store.listWhitelist();
  const flags = store.listFlags();

  // «Проверен» = есть в whitelist ИЛИ помечен НЕ ошибкой (ошибку перепроверяем).
  const isChecked = (p) => wl[p.uuid] || (flags[p.uuid] && flags[p.uuid].reason !== 'error');

  let todo = all;
  if (!args.all) todo = todo.filter((p) => !isChecked(p));
  if (args.tag) todo = todo.filter((p) => (p.tags || []).includes(args.tag));

  console.log(`Всего профилей: ${all.length}. Уже проверено: ${all.length - all.filter((p) => !isChecked(p)).length}. К проверке сейчас: ${todo.length}`);
  if (args.tag) console.log(`Фильтр по тегу: "${args.tag}"`);
  if (!todo.length) { console.log('Нечего проверять.'); process.exit(0); }

  const concurrency = Math.max(1, args.concurrency);
  const results = { ok: [], checkpoint: [], disabled: [], logout: [], error: [] };
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
        try { store.flagProfile(p.uuid, 'error'); } catch { /* ignore */ }
        results.error.push({ title: p.title, error: e.message });
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
    checkpoint: 'CHECKPOINT / требуют проверки',
    disabled: 'БАН (аккаунт отключён)',
    logout: 'РАЗЛОГИН (сессия слетела)',
    error: 'ОШИБКА ОТКРЫТИЯ (перепроверить)',
  };
  console.log('\n\n===== ИТОГ =====');
  console.log(`Живых: ${results.ok.length}`);
  for (const key of ['checkpoint', 'disabled', 'logout', 'error']) {
    const list = results[key];
    if (!list.length) continue;
    console.log(`\n${labels[key]}: ${list.length}`);
    for (const it of list) console.log(`  - ${it.title}${it.error ? `  (${it.error})` : ''}`);
  }
  console.log('\nWhitelist обновлён, пометки проставлены.');
  process.exit(0);
}

main().catch((e) => { console.error('Сбой скрипта:', e); process.exit(1); });
