// Уникализация хвоста комментария БЕЗ изменения слов: меняем только окончание
// (точка / восклицательный знак) и добавляем разный эмодзи в конце. Смысл и
// слова остаются нетронутыми — меняется лишь «концовка».

const EMOJIS = ['🔥', '👍', '😍', '💯', '😊', '👏', '🙌', '⚡', '✨', '❤️', '😎', '🤝', '🙏', '😋', '🥳'];
const ENDINGS = ['.', '!', '!!'];

// Убрать уже имеющуюся хвостовую пунктуацию/пробелы, чтобы задать свою концовку.
function stripEnd(s) {
  return String(s).replace(/[\s.!?…]+$/u, '');
}

// Вернуть n РАЗЛИЧНЫХ вариантов базового текста (концовка + эмодзи).
// Комбинаций хватает на десятки постов; для батча гарантируем уникальность.
function uniquifyBatch(base, n) {
  const core = stripEnd(base);
  const combos = [];
  for (const end of ENDINGS) {
    for (const em of EMOJIS) {
      combos.push(`${core}${end} ${em}`);
    }
  }
  // перемешать (Фишер–Йейтс)
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(combos[i % combos.length]);
  return out;
}

module.exports = { uniquifyBatch, EMOJIS, ENDINGS };
