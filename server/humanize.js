// Набор помощников для имитации человеческого поведения в Playwright.
// Идея: не мгновенные действия, а движения с траекторией, инерцией,
// микро-паузами, промахами (overshoot) и небольшой «неаккуратностью».
//
// Ключевое дополнение — ПЕРСОНА: у каждого профиля Octo свой стабильный
// «характер» (скорость мыши, темп печати, склонность к опечаткам и т.д.),
// который не меняется между запусками. Это убирает главный признак бота —
// когда «человек» каждый раз ведёт себя статистически по-разному.

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));

// Плавная ease-in-out кривая для естественного ускорения/замедления.
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// ─────────────────────────────────────────────────────────────────────────
// ПЕРСОНА
// ─────────────────────────────────────────────────────────────────────────

// Детерминированный ГПСЧ (mulberry32) — из одного seed всегда одна и та же
// последовательность. Используем ТОЛЬКО для фиксированных черт персоны,
// а сиюминутную дрожь оставляем на Math.random(), чтобы прогоны различались.
function makeSeededRng(seedStr) {
  let h = 1779033703 ^ String(seedStr).length;
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Создать стабильную персону из seed (обычно profileUuid).
// Каждая черта — фиксирована для профиля, но в человеческих пределах.
function createPersona(seed) {
  const r = makeSeededRng(seed || 'default');
  const pick = (min, max) => r() * (max - min) + min;

  return {
    seed: String(seed || 'default'),
    // Скорость мыши: множитель. >1 быстрее (меньше пауза между микрошагами).
    mouseSpeed: pick(0.75, 1.35),
    // Насколько «дёрганая» рука — амплитуда дрожания курсора, px.
    handJitter: pick(0.8, 2.2),
    // Вероятность промахнуться мимо цели и скорректироваться.
    overshootChance: pick(0.18, 0.5),
    // Базовая задержка печати, мс (аналог WPM: меньше = быстрее).
    typeBase: pick(58, 118),
    // Разброс темпа внутри набора.
    typeDrift: pick(8, 15),
    // Вероятность опечатки на символ (~1–2% — как у реального человека).
    typoRate: pick(0.008, 0.022),
    // Вероятность «раздумья» (длинной паузы) на символ.
    ponderRate: pick(0.02, 0.05),
    // Печатает «вспышками» по словам (пауза перед новым словом).
    burstiness: pick(0.4, 0.9),
    // Предпочитает кликнуть кнопку отправки (иначе Enter).
    prefersButton: pick(0.3, 0.75),
    // Склонность водить мышью во время чтения/печати.
    fidget: pick(0.15, 0.45),
  };
}

// Персона хранится на объекте page. Если не задана — нейтральный дефолт.
function getPersona(page) {
  if (!page.__persona) page.__persona = createPersona('default');
  return page.__persona;
}

// ─────────────────────────────────────────────────────────────────────────
// МЫШЬ
// ─────────────────────────────────────────────────────────────────────────

// Текущую позицию мыши Playwright не отдаёт, поэтому храним её сами на page.
function getMouse(page) {
  if (!page.__mouse) page.__mouse = { x: randInt(60, 400), y: randInt(60, 400) };
  return page.__mouse;
}

// Один «перелёт» курсора из текущей точки в (tx, ty) по дуге Безье.
// Число шагов и скорость зависят от дистанции (закон Фиттса): дальние
// движения — размашистые и быстрые в середине, с резким торможением у цели.
// Внутри пути возможны редкие микро-остановки (будто на миг отвлёкся).
async function travel(page, tx, ty, opts = {}) {
  const p = getPersona(page);
  const from = getMouse(page);
  const dist = Math.hypot(tx - from.x, ty - from.y);

  // Фиттс: шагов больше на длинных дистанциях, но с насыщением.
  const baseSteps = Math.round(10 + Math.sqrt(dist) * 1.6);
  const steps = Math.max(6, Math.min(opts.maxSteps || 46, baseSteps));

  // Кривизна дуги пропорциональна дистанции — короткие движения почти прямые.
  const bend = Math.min(120, dist * 0.35) * (opts.bend ?? 1);
  const cx = (from.x + tx) / 2 + rand(-bend, bend);
  const cy = (from.y + ty) / 2 + rand(-bend, bend);

  const jitter = p.handJitter * (opts.jitter ?? 1);

  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps);
    const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * tx + rand(-jitter, jitter);
    const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * ty + rand(-jitter, jitter);
    await page.mouse.move(x, y);

    // Быстрее в середине траектории, медленнее у концов; плюс скорость персоны.
    const speedFactor = 0.55 + (1 - Math.abs(0.5 - i / steps) * 2) * 0.9;
    let stepSleep = rand(5, 15) / (p.mouseSpeed * speedFactor);

    // Редкая микро-остановка в пути (не на последних шагах).
    if (i < steps - 3 && Math.random() < 0.03) stepSleep += rand(90, 260);

    await sleep(stepSleep);
  }
  page.__mouse = { x: tx, y: ty };
}

// Движение к цели с возможным промахом: проскочить мимо на несколько px
// и вернуться коротким корректирующим движением — как настоящая рука.
async function moveMouse(page, tx, ty) {
  const p = getPersona(page);
  const from = getMouse(page);
  const dist = Math.hypot(tx - from.x, ty - from.y);

  // Промахиваемся тем вероятнее и сильнее, чем длиннее и быстрее движение.
  if (dist > 120 && Math.random() < p.overshootChance) {
    const dx = tx - from.x;
    const dy = ty - from.y;
    const norm = Math.hypot(dx, dy) || 1;
    const over = rand(6, 18) * (0.6 + dist / 800);
    const ox = tx + (dx / norm) * over + rand(-4, 4);
    const oy = ty + (dy / norm) * over + rand(-4, 4);

    await travel(page, ox, oy); // проскочили цель
    await sleep(rand(60, 180)); // «ой, промахнулся»
    await travel(page, tx, ty, { maxSteps: 14, bend: 0.3, jitter: 0.6 }); // коррекция
    return;
  }

  await travel(page, tx, ty);
}

// Навести курсор на случайную точку внутри элемента (смещённую от центра).
async function moveToElement(page, handle) {
  const box = await handle.boundingBox();
  if (!box) throw new Error('Элемент вне видимой области — не могу навести курсор');
  const tx = box.x + box.width * rand(0.3, 0.7);
  const ty = box.y + box.height * rand(0.3, 0.7);
  await moveMouse(page, tx, ty);
  return { tx, ty, box };
}

// Небольшое «блуждание» курсора без цели — как будто человек ведёт мышь во
// время чтения. ВАЖНО: только движение, НИКАКИХ кликов — ничего лишнего.
async function idleMouse(page) {
  const m = getMouse(page);
  const tx = Math.max(5, m.x + rand(-160, 160));
  const ty = Math.max(5, m.y + rand(-120, 120));
  await travel(page, tx, ty, { maxSteps: 22, jitter: 0.8 });
}

// Клик по элементу: наведение -> пауза (hover) -> нажатие с задержкой down/up.
async function humanClick(page, handle) {
  await moveToElement(page, handle);
  await sleep(rand(120, 400)); // задержка перед кликом (навёлся и «прицелился»)
  await page.mouse.down();
  await sleep(rand(40, 120));
  await page.mouse.up();
}

// ─────────────────────────────────────────────────────────────────────────
// СКРОЛЛ
// ─────────────────────────────────────────────────────────────────────────

// Прокрутка страницы реальными событиями колеса.
// Каждый «рывок» колеса имеет инерцию: старт быстрый, затем импульс затухает
// (как настоящее колесо мыши), а паузы между тиками растут.
async function humanScroll(page, opts = {}) {
  const p = getPersona(page);
  // Короче по умолчанию: 2–3 рывка. Рывок «длиннее» (больше тиков) — так за
  // меньшее число пауз проходим то же расстояние, и суммарно быстрее.
  const bursts = opts.bursts || randInt(2, 3);
  for (let b = 0; b < bursts; b++) {
    const ticks = randInt(4, 7);
    let speed = rand(60, 110); // начальная скорость рывка (чуть выше)
    for (let t = 0; t < ticks; t++) {
      await page.mouse.wheel(0, speed + rand(-6, 6));
      speed *= rand(0.78, 0.92); // затухание импульса
      await sleep(rand(8, 22) * (1 + t * 0.12)); // паузы между тиками растут
    }
    await sleep(rand(280, 800)); // пауза между рывками — короткий «взгляд»

    // Изредка проскроллить назад (перечитать) — по-человечески, но теперь реже.
    if (Math.random() < 0.1 + p.fidget * 0.2) {
      await page.mouse.wheel(0, -randInt(40, 110));
      await sleep(rand(250, 650));
    }

    // Изредка слегка водим мышью во время чтения (без кликов). В режиме поиска
    // коммента в модалке это ОТКЛЮЧАЕМ (noIdle) — иначе курсор уходит из модалки
    // и колесо начинает крутить ленту за постом.
    if (!opts.noIdle && Math.random() < p.fidget * 0.5) await idleMouse(page);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ПЕЧАТЬ
// ─────────────────────────────────────────────────────────────────────────

// Оценка времени чтения по объёму текста (мс). Базовое «осмотрелся» + пропорция
// от длины, с потолком, чтобы не ждать вечность на огромных страницах.
function readingTimeFor(textLength) {
  const capped = Math.min(textLength, 3500);
  const ms = 1500 + capped * rand(1.1, 2.0);
  return Math.min(Math.round(ms), 12000);
}

// Раскладка QWERTY (+ соответствие ЙЦУКЕН по позиции клавиш): для каждой
// клавиши — физические соседи. Опечатка = нажать СОСЕДНЮЮ клавишу, а не
// случайную букву. Так исправления выглядят естественно.
const QWERTY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
// ЙЦУКЕН в порядке тех же физических клавиш, что и QWERTY выше.
const JCUKEN_ROWS = ['йцукенгшщз', 'фывапролд', 'ячсмить'];

function buildNeighbors(rows) {
  const map = {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const key = row[c];
      const nb = new Set();
      if (c > 0) nb.add(row[c - 1]);
      if (c < row.length - 1) nb.add(row[c + 1]);
      for (const dr of [-1, 1]) {
        const or_ = rows[r + dr];
        if (!or_) continue;
        for (const dc of [-1, 0, 1]) {
          const ch = or_[c + dc];
          if (ch) nb.add(ch);
        }
      }
      map[key] = [...nb];
    }
  }
  return map;
}

const NEIGHBORS = { ...buildNeighbors(QWERTY_ROWS), ...buildNeighbors(JCUKEN_ROWS) };

// Соседняя «неправильная» клавиша для имитации опечатки (с учётом регистра).
function neighborKey(ch) {
  const lower = ch.toLowerCase();
  const list = NEIGHBORS[lower];
  let c;
  if (list && list.length) {
    c = list[Math.floor(Math.random() * list.length)];
  } else {
    const set = 'qwertyuiopasdfghjklzxcvbnm';
    c = set[Math.floor(Math.random() * set.length)];
  }
  return ch === ch.toUpperCase() && ch !== lower ? c.toUpperCase() : c;
}

// Печать по одному символу с человеческим ритмом:
//  - стартовая пауза «собираюсь с мыслями», растёт с длиной текста;
//  - дрейф скорости (то разгон, то замедление) + burst по словам;
//  - паузы на пробелах/пунктуации и редкие «раздумья»;
//  - изредка микродвижение мышью во время печати (без кликов);
//  - ОТЛОЖЕННАЯ опечатка соседней клавишей: неверная буква, ещё 1–3 символа,
//    пауза, стирание Backspace и правильный ввод. Итог всегда == целевому.
// Разбить текст на ГРАФЕМЫ (эмодзи остаётся целым, а не рвётся на суррогатные
// половинки — иначе браузер печатает «��»). Intl.Segmenter, иначе по code points.
function toGraphemes(text) {
  try {
    const seg = new Intl.Segmenter('ru', { granularity: 'grapheme' });
    return Array.from(seg.segment(String(text)), (s) => s.segment);
  } catch {
    return Array.from(String(text)); // хотя бы не рвёт суррогатные пары
  }
}

async function humanType(page, text) {
  const p = getPersona(page);
  const chars = toGraphemes(text);

  // «Собираюсь с мыслями» перед началом — тем дольше, чем длиннее коммент.
  await sleep(rand(300, 650) + Math.min(chars.length, 200) * rand(2, 5));

  let base = p.typeBase; // базовая задержка, плавно дрейфует по ходу набора

  let i = 0;
  while (i < chars.length) {
    // Плавный дрейф базовой скорости (случайное блуждание в разумных пределах).
    base += rand(-p.typeDrift, p.typeDrift);
    base = Math.min(p.typeBase + 55, Math.max(42, base));

    const ch = chars[i];

    // Отложенная опечатка (частота — черта персоны). Чаще исправляем сразу,
    // реже — заметив ошибку на 1–2 символа позже (0–2 символа «не заметив»).
    if (/[a-zа-яё]/i.test(ch) && Math.random() < p.typoRate) {
      const extra = Math.random() < 0.6 ? 0 : randInt(1, 2);

      // Ошиблись СОСЕДНЕЙ клавишей вместо нужного символа.
      await page.keyboard.type(neighborKey(ch));
      await sleep(base + rand(0, 60));

      // Печатаем ещё несколько СЛЕДУЮЩИХ символов как есть.
      const ahead = [];
      for (let k = 1; k <= extra && i + k < chars.length; k++) {
        await page.keyboard.type(chars[i + k]);
        ahead.push(chars[i + k]);
        await sleep(base + rand(0, 70));
      }

      // «Заметили» ошибку — короткая пауза.
      await sleep(rand(250, 700));

      // Стираем неверный символ + всё, что напечатали вперёд.
      for (let d = 0; d < 1 + ahead.length; d++) {
        await page.keyboard.press('Backspace');
        await sleep(rand(70, 170));
      }
      await sleep(rand(120, 350));

      // Печатаем текущий символ правильно; следующие уйдут обычным циклом.
      await page.keyboard.type(ch);
      await sleep(base + (ch === ' ' ? rand(40, 170) : 0));
      i++;
      continue;
    }

    // Перенос строки — Shift+Enter (мягкий перенос). Просто Enter в поле FB
    // ОТПРАВЛЯЕТ коммент раньше времени → поле чистится → перепечатка/повторная
    // отправка → дубль. Поэтому переносы вводим через Shift+Enter.
    if (ch === '\n' || ch === '\r') {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await sleep(Math.max(30, base + rand(0, 80)));
      i++;
      continue;
    }

    await page.keyboard.type(ch);

    let delay = base + rand(-18, 35);
    if (ch === ' ') {
      // Пауза перед новым словом — «вспышечная» печать (burst).
      delay += rand(30, 120) + p.burstiness * rand(20, 110);
      // Изредка во время паузы между словами чуть двигаем мышь (без клика).
      if (Math.random() < p.fidget * 0.2) await idleMouse(page);
    }
    if ('.,!?;:'.includes(ch)) delay += rand(110, 340);
    if (Math.random() < p.ponderRate) delay += rand(250, 650); // «подумал»
    await sleep(Math.max(30, delay));
    i++;
  }
}

module.exports = {
  sleep,
  rand,
  randInt,
  createPersona,
  getPersona,
  moveMouse,
  moveToElement,
  idleMouse,
  humanClick,
  humanScroll,
  humanType,
  readingTimeFor,
};
