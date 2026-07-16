import { useState, useEffect, useRef } from 'react'
import axios from 'axios'

// Адрес API. Если задан VITE_API_BASE — берём его. Иначе автоопределение:
// на Vite-dev (порт 5173) ходим на локальный бэкенд :3000; когда фронт отдаёт
// сам бэкенд/туннель (любой другой origin) — относительные пути (/api,/uploads).
const API_BASE = import.meta.env.VITE_API_BASE ?? (
  (typeof location !== 'undefined' && location.port === '5173')
    ? 'http://localhost:3000'
    : ''
)

// Куку сессии шлём со всеми запросами (нужно, когда бот встроен в таск-менеджер).
axios.defaults.withCredentials = true

// Одноразовое SSO-рукопожатие: если в URL пришёл ?sso= от таск-менеджера —
// меняем его на сессионную куку бота и чистим URL, чтобы токен не светился.
// В standalone (?sso нет) промис резолвится сразу.
const ssoReady = (async () => {
  const sso = new URLSearchParams(window.location.search).get('sso')
  if (!sso) return
  try {
    await axios.post(`${API_BASE}/api/sso/accept`, { token: sso })
  } catch { /* статус проверим через /api/me */ }
  const url = new URL(window.location.href)
  url.searchParams.delete('sso')
  window.history.replaceState({}, '', url.pathname + url.search)
})()

// В проде бот открывается только внутри кабинета (в iframe). Прямой заход на
// домен показывает заглушку. Локально (localhost) работает standalone — для отладки.
const IS_EMBEDDED = typeof window !== 'undefined' && window.self !== window.top
const IS_LOCAL = typeof location !== 'undefined'
  && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)

// Синхронизация темы с таск-менеджером: родитель шлёт {type:'octobot-theme', theme},
// а мы переключаем класс .dark на <html>. При загрузке сообщаем родителю, что готовы.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.type !== 'octobot-theme') return
    const root = document.documentElement
    if (d.theme === 'light') root.classList.remove('dark')
    else root.classList.add('dark')
  })
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'octobot-ready' }, '*')
  } catch { /* ignore */ }
}

// Показываем только профили с тегами Fakes / Sweeps (матчим по вхождению слов).
const ALLOWED_TAGS = ['Fakes', 'Sweeps']
const TAG_KEYWORDS = ['fake', 'sweep']
const isAllowedTag = (t) => {
  const s = String(t).toLowerCase()
  return TAG_KEYWORDS.some((k) => s.includes(k))
}

const STATUS_COLORS = {
  queued: 'var(--warn)',
  running: 'var(--accent)',
  done: 'var(--ok)',
  error: 'var(--danger)',
  canceled: 'var(--muted)',
}

const isTerminal = (s) => s === 'done' || s === 'error' || s === 'canceled'

// Время суток «14:32» (24 ч) из абсолютного времени в мс.
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

// Дата+время «04.07 14:32» из ISO-строки или мс.
const fmtDateTime = (v) => {
  if (!v) return ''
  return new Date(v).toLocaleString([], {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// Короткий статус задачи вместо логов.
function taskStatusText(task) {
  if (task.status === 'done') return 'Готово ✓'
  if (task.status === 'error') return 'Не получилось'
  if (task.status === 'canceled') return 'Отменено'
  if (task.status === 'running') return 'Выполняется…'
  if (task.status === 'queued' && task.delayed && task.scheduledAt) {
    return `Старт в ${fmtClock(task.scheduledAt)}`
  }
  return 'В очереди'
}

// Максимум постов за один раз (совпадает с серверным лимитом на фейк).
const MAX_POSTS = 10

// Режимы с двумя уровнями вкладок: Оффер → Операция. Лимита на число операций нет.
const MODE_IDS = [1, 2, 3, 4]

// Достроить недостающие режимы (напр. новый Режим 4 у пользователей со старой
// структурой), чтобы offers[m] всегда существовал и рендер не падал.
function ensureAllModes(s) {
  for (const m of MODE_IDS) {
    if (!s.offers[m] || !s.offers[m].length) {
      s.offers[m] = [{ id: 1, name: 'Оффер 1', ops: [{ id: 1, name: 'Операция 1' }], activeOp: 1 }]
      s.activeOffer[m] = 1; s.nextOfferId[m] = 2; s.nextOpId[m] = 2
    }
    if (s.activeOffer[m] == null) s.activeOffer[m] = s.offers[m][0].id
    if (s.nextOfferId[m] == null) s.nextOfferId[m] = Math.max(...s.offers[m].map((o) => o.id)) + 1
    if (s.nextOpId[m] == null) s.nextOpId[m] = 2
  }
  return s
}

// Структура вкладок по умолчанию: в каждом режиме один оффер с одной операцией.
function defaultOffers() {
  const offers = {}; const activeOffer = {}; const nextOfferId = {}; const nextOpId = {}
  for (const m of MODE_IDS) {
    offers[m] = [{ id: 1, name: 'Оффер 1', ops: [{ id: 1, name: 'Операция 1' }], activeOp: 1 }]
    activeOffer[m] = 1; nextOfferId[m] = 2; nextOpId[m] = 2
  }
  return { offers, activeOffer, nextOfferId, nextOpId }
}

// Привести сохранённую структуру к новому формату (в т.ч. миграция со старого
// плоского { tabs, activeId, nextId } — оборачиваем операции в один оффер).
function migrateStruct(t) {
  if (!t) return defaultOffers()
  if (t.offers && t.activeOffer && t.nextOfferId && t.nextOpId) return ensureAllModes(t)
  if (t.tabs && t.activeId && t.nextId) {
    const offers = {}; const activeOffer = {}; const nextOfferId = {}; const nextOpId = {}
    for (const m of MODE_IDS) {
      const ops = (t.tabs[m] || [{ id: 1 }]).map((x, i) => ({ id: x.id, name: `Операция ${i + 1}` }))
      offers[m] = [{ id: 1, name: 'Оффер 1', ops, activeOp: t.activeId[m] || ops[0].id }]
      activeOffer[m] = 1; nextOfferId[m] = 2; nextOpId[m] = t.nextId[m] || (ops.length + 1)
    }
    return ensureAllModes({ offers, activeOffer, nextOfferId, nextOpId })
  }
  return defaultOffers()
}

// Вкладка с переименованием по двойному клику (для офферов и операций).
function EditableTab({
  label, active, onActivate, onRename, onClose, closable,
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(label)
  const startEdit = () => { setVal(label); setEditing(true) }
  const commit = () => { setEditing(false); const v = val.trim(); if (v && v !== label) onRename(v) }
  return (
    <div
      role="button"
      tabIndex={0}
      className={`tm-tab${active ? ' active' : ''}`}
      onClick={() => { if (!editing) onActivate() }}
      onDoubleClick={startEdit}
      onKeyDown={(e) => { if (e.key === 'Enter' && !editing) onActivate() }}
      title={editing ? '' : 'Двойной клик — переименовать'}
    >
      {editing ? (
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape') { setVal(label); setEditing(false) }
          }}
          style={{
            width: `${Math.max(6, val.length)}ch`, font: 'inherit', border: 'none', background: 'transparent', color: 'inherit', outline: 'none', padding: 0,
          }}
        />
      ) : label}
      {closable && !editing && (
        <span
          role="button"
          tabIndex={0}
          className="tm-tab-x"
          title="Закрыть"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onClose() } }}
        >
          ×
        </span>
      )}
    </div>
  )
}

// Человечная вариация картинки: лёгкий рекадр/фильтр/пересохранение — как
// естественный ре-шер, а не «невидимый шум». Меняет отпечаток, выглядит живо.
// Полный src картинки: data:URL как есть, серверный '/uploads/..' — с API_BASE.
function imageSrc(v) {
  if (!v) return ''
  return v.startsWith('data:') ? v : `${API_BASE}${v}`
}

// Загрузить картинку на сервер (файлом). Возвращает URL или null.
async function uploadDraftImage(dataUrl) {
  try {
    const { data } = await axios.post(`${API_BASE}/api/drafts/image`, { image: dataUrl })
    return (data && data.url) || null
  } catch { return null }
}

function varyImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    // БЕЗ crossOrigin: картинки /uploads — того же origin, тейнта нет. С crossOrigin
    // браузер переиспользовал не-CORS кэш от превью → canvas tainted → toDataURL
    // падал → в задачу уходил URL, и картинка не сохранялась в истории/логах.
    img.onload = () => {
      const W = img.naturalWidth
      const H = img.naturalHeight
      if (!W || !H) { resolve(dataUrl); return }
      try {
      const rnd = (a, b) => a + Math.random() * (b - a)
      const cl = Math.round(W * rnd(0, 0.06))
      const cr = Math.round(W * rnd(0, 0.06))
      const ct = Math.round(H * rnd(0, 0.06))
      const cb = Math.round(H * rnd(0, 0.06))
      const sw = Math.max(8, W - cl - cr)
      const sh = Math.max(8, H - ct - cb)
      // Ограничиваем итоговый размер: большие фото давали тяжёлый base64, и
      // туннель рвал загрузку запроса ("request aborted"/502). Ужимаем длинную
      // сторону до MAX_DIM — картинка лёгкая, грузится надёжно, визуально та же.
      const MAX_DIM = 960
      const fit = Math.min(1, MAX_DIM / Math.max(sw, sh))
      const scale = rnd(0.9, 1.0) * fit
      const dw = Math.max(8, Math.round(sw * scale))
      const dh = Math.max(8, Math.round(sh * scale))
      const canvas = document.createElement('canvas')
      canvas.width = dw
      canvas.height = dh
      const ctx = canvas.getContext('2d')
      ctx.filter = `brightness(${rnd(0.94, 1.06).toFixed(3)}) `
        + `contrast(${rnd(0.94, 1.06).toFixed(3)}) `
        + `saturate(${rnd(0.92, 1.08).toFixed(3)}) `
        + `hue-rotate(${rnd(-4, 4).toFixed(1)}deg)`
      ctx.drawImage(img, cl, ct, sw, sh, 0, 0, dw, dh)
      resolve(canvas.toDataURL('image/jpeg', rnd(0.66, 0.72)))
      } catch { resolve(dataUrl) } // напр. canvas «tainted» при кросс-домене
    }
    img.onerror = () => resolve(dataUrl)
    img.src = imageSrc(dataUrl)
  })
}

// POST задачи с ретраем: туннель Cloudflare иногда дропает тело запроса с
// картинкой (502/«request aborted»). Повторяем на 502/503/504/сетевой сбой.
async function postTasks(payload, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i += 1) {
    try {
      return await axios.post(`${API_BASE}/api/tasks`, payload)
    } catch (e) {
      lastErr = e
      const code = e.response && e.response.status
      if (code && ![502, 503, 504].includes(code)) throw e
      await new Promise((r) => { setTimeout(r, 800 + i * 800) })
    }
  }
  throw lastErr
}

// Иконка обновления.
function RefreshIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

// Поле загрузки картинки + превью + крестик снятия.
function ImagePicker({
  image, imageName, onPick, onClear, size = 44,
}) {
  return (
    <div style={{ position: 'relative', flex: '0 0 auto' }}>
      <label className="tm-imgbox" title={imageName || 'Прикрепить картинку'} style={{ width: size, height: size }}>
        {image ? (
          <img src={imageSrc(image)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: '17px' }}>🖼</span>
        )}
        <input
          type="file"
          accept="image/*"
          onChange={(e) => onPick(e.target.files && e.target.files[0])}
          style={{ display: 'none' }}
        />
      </label>
      {image && (
        <button type="button" className="tm-img-remove" onClick={onClear} title="Убрать картинку">×</button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Одна операция (вкладка): выбор фейка, посты с картинками, текст, запуск.
// Профили и таймеры занятости приходят сверху (общие для всех вкладок).
// ─────────────────────────────────────────────────────────────────────────
function Operation({
  mode, opId, initial, profiles, loadingProfiles, profilesError, loadProfiles, busy, busyAt, now,
}) {
  // Черновик операции хранится на СЕРВЕРЕ (надёжно). Начальные значения приходят
  // из уже загруженной карты черновиков (prop initial). Ключ — режим+операция.
  const draftKey = `op:${mode}:${opId}`
  const [saved] = useState(() => initial || {})
  const draftSaveTimer = useRef(null)
  const [profileUuid, setProfileUuid] = useState(saved.profileUuid || '')
  const [posts, setPosts] = useState(saved.posts || [{ url: '', image: null, imageName: '' }])
  // Режим 1: одна картинка на всю операцию (её вешаем на КАЖДЫЙ пост, делая из
  // неё уникальный вариант). Не привязана к конкретной ссылке.
  const [opImage, setOpImage] = useState(saved.opImage || null)
  const [opImageName, setOpImageName] = useState(saved.opImageName || '')
  const [commentText, setCommentText] = useState(saved.commentText || '')
  // Режим 1: свой текст на каждый пост (когда баер размножил поля). Пусто = общий текст.
  const [perComments, setPerComments] = useState(saved.perComments || [])
  const [tasks, setTasks] = useState(saved.tasks || [])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Защита от двойного клика по «Повторить/Продолжить»: id/dialogId в работе.
  const [retrying, setRetrying] = useState({})
  const [search, setSearch] = useState('')
  // Режим 2: один пост -> много фейков (каждый со своим тегом/фейком/комментом/картинкой).
  const [post2, setPost2] = useState(saved.post2 || '')
  const [entries, setEntries] = useState(saved.entries || [{
    profileUuid: '', tag: '', search: '', comment: '', image: null, imageName: '',
  }])
  // Режим 3: диалоги. dialogs[].steps[] = { profileUuid, tag, text, replyTo, image }.
  const [post3, setPost3] = useState(saved.post3 || '')
  const newStep = (replyTo = null) => ({
    profileUuid: '', tag: '', search: '', text: '', replyTo, image: null, imageName: '',
  })
  const [dialogs, setDialogs] = useState(saved.dialogs || [{ steps: [newStep(null)] }])
  // Режим 4: чистка — ссылка на пост (админ хранится в profileUuid).
  const [post4, setPost4] = useState(saved.post4 || '')
  // Режим 4: страницы FB-переключателя выбранного админа + выбранная страница.
  const [pages, setPages] = useState([])
  const [pageName, setPageName] = useState(saved.pageName || '')
  const [collectingPages, setCollectingPages] = useState(false)
  const [collectSeconds, setCollectSeconds] = useState(0)
  // Режим 4: наблюдение (авто-чистка) — список отслеживаемых постов + здоровье скаута.
  const [watchItems, setWatchItems] = useState([])
  const [watchScout, setWatchScout] = useState(null)
  const [watchBusy, setWatchBusy] = useState(false)
  const collectTimerRef = useRef(null)
  const pollRef = useRef(null)
  const latestData = useRef(null)

  // Сохраняем черновик на сервер (debounce). Картинки хранятся как серверные URL
  // (загружаются при выборе), поэтому тело маленькое — без квоты и потери данных.
  useEffect(() => {
    const data = {
      profileUuid, posts, commentText, perComments, tasks, post2, entries, post3, dialogs, opImage, opImageName, post4, pageName,
    }
    latestData.current = data
    clearTimeout(draftSaveTimer.current)
    draftSaveTimer.current = setTimeout(() => {
      axios.put(`${API_BASE}/api/drafts/${draftKey}`, data).catch(() => {})
    }, 700)
    return () => clearTimeout(draftSaveTimer.current)
  }, [draftKey, profileUuid, posts, commentText, perComments, tasks, post2, entries, post3, dialogs, opImage, opImageName, post4, pageName])

  // Режим 4: подтягиваем сохранённые страницы выбранного админ-профиля.
  useEffect(() => {
    if (mode !== 4 || !profileUuid) return undefined
    let alive = true
    axios.get(`${API_BASE}/api/pages/${profileUuid}`)
      .then(({ data }) => { if (alive) setPages(data.pages || []) })
      .catch(() => { if (alive) setPages([]) })
    return () => { alive = false }
  }, [mode, profileUuid])

  // При размонтировании (например, переключили оффер) — дописываем последнее
  // состояние сразу, чтобы не потерять правки, не успевшие уйти по debounce.
  useEffect(() => () => {
    if (latestData.current) axios.put(`${API_BASE}/api/drafts/${draftKey}`, latestData.current).catch(() => {})
  }, [draftKey])

  // Метка занятости профиля: «занят до 14:32» (уже идёт) или «занят с 15:10».
  const profileBusy = (uuid) => {
    const info = busy[uuid]
    if (!info) return null
    const elapsed = now - busyAt
    if (info.freeInMs - elapsed <= 0) return null
    const startLeft = info.startInMs - elapsed
    if (startLeft > 5000) return `занят с ${fmtClock(busyAt + info.startInMs)}`
    return `занят до ${fmtClock(busyAt + info.freeInMs)}`
  }

  // Список зафиксирован на фейках (теги Fakes/Sweeps) — выбор тега убран из UI.
  const baseProfiles = profiles.filter((p) => (p.tags || []).some(isAllowedTag))
  // Режим 4: админ-профили с тегом «Hide» (право скрывать чужие комменты).
  const adminProfiles = profiles.filter((p) => (p.tags || []).includes('Hide'))
  const source = baseProfiles
  const filteredProfiles = source.filter(
    (p) => !search || (p.title || '').toLowerCase().includes(search.toLowerCase()),
  )

  // Поллинг незавершённых задач этой операции.
  useEffect(() => {
    const anyActive = tasks.some((t) => !isTerminal(t.status))
    if (!anyActive) return undefined
    pollRef.current = setInterval(async () => {
      try {
        const updated = await Promise.all(
          tasks.map(async (t) => {
            if (isTerminal(t.status)) return t
            const { data } = await axios.get(`${API_BASE}/api/tasks/${t.id}`)
            return { ...t, ...data }
          }),
        )
        setTasks(updated)
      } catch { /* пропустим тик */ }
    }, 2000)
    return () => clearInterval(pollRef.current)
  }, [tasks])

  const patchPost = (i, patch) => setPosts((p) => p.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
  const addPost = () => {
    setPosts((p) => (p.length >= MAX_POSTS ? p : [...p, { url: '', image: null, imageName: '' }]))
    // Держим поля «свой текст» в такт числу постов.
    setPerComments((arr) => (arr.length === 0 || arr.length >= MAX_POSTS ? arr : [...arr, commentText]))
  }
  const removePost = (i) => {
    setPosts((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)))
    setPerComments((arr) => (arr.length <= 1 ? arr : arr.filter((_, idx) => idx !== i)))
  }

  const pickOpImage = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      setOpImage(reader.result); setOpImageName(file.name) // мгновенное превью
      const url = await uploadDraftImage(reader.result) // затем — файл на сервер
      if (url) setOpImage(url)
    }
    reader.readAsDataURL(file)
  }

  // Название фейка по uuid (для короткого итога).
  const profileTitle = (uuid) => {
    const p = profiles.find((x) => x.uuid === uuid)
    if (p) return p.title
    return uuid ? `${uuid.slice(0, 8)}…` : ''
  }

  // Управление списком «фейк + комментарий» в режиме 2.
  const patchEntry = (i, patch) => setEntries((a) => a.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
  const addEntry = () => setEntries((a) => [...a, {
    profileUuid: '', tag: '', search: '', comment: '', image: null, imageName: '',
  }])
  // Профили для строки фейка: по её тегу (или Fakes/Sweeps по умолчанию).
  const entryProfiles = (tag) => (tag ? profiles.filter((p) => (p.tags || []).includes(tag)) : baseProfiles)
  const removeEntry = (i) => setEntries((a) => (a.length === 1 ? a : a.filter((_, idx) => idx !== i)))
  const pickEntryImage = (i, file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      patchEntry(i, { image: reader.result, imageName: file.name })
      const url = await uploadDraftImage(reader.result)
      if (url) patchEntry(i, { image: url })
    }
    reader.readAsDataURL(file)
  }

  // ---- Режим 3: билдер диалогов ----
  const patchStep = (di, si, patch) => setDialogs((ds) => ds.map((d, i) => (i !== di ? d
    : { steps: d.steps.map((s, j) => (j === si ? { ...s, ...patch } : s)) })))
  const addStep = (di) => setDialogs((ds) => ds.map((d, i) => (i !== di ? d
    : { steps: [...d.steps, newStep(0)] })))
  const removeStep = (di, si) => setDialogs((ds) => ds.map((d, i) => (i !== di ? d
    : { steps: d.steps.length === 1 ? d.steps : d.steps.filter((_, j) => j !== si) })))
  const addDialog = () => setDialogs((ds) => [...ds, { steps: [newStep(null)] }])
  const removeDialog = (di) => setDialogs((ds) => (ds.length === 1 ? ds : ds.filter((_, i) => i !== di)))
  const pickStepImage = (di, si, file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      patchStep(di, si, { image: reader.result, imageName: file.name })
      const url = await uploadDraftImage(reader.result)
      if (url) patchStep(di, si, { image: url })
    }
    reader.readAsDataURL(file)
  }

  const startMode3 = async () => {
    setError('')
    const url = post3.trim()
    if (!url) { setError('Введите ссылку на пост'); return }

    const cleanDialogs = dialogs.map((d) => {
      const map = {}
      const kept = []
      d.steps.forEach((s, oi) => {
        if (s.profileUuid && (s.text || '').trim()) { map[oi] = kept.length; kept.push(s) }
      })
      const steps = kept.map((s, ni) => ({
        profileUuid: s.profileUuid,
        text: s.text.trim(),
        replyTo: ni === 0 ? null : Math.min(ni - 1, Math.max(0, (s.replyTo != null && map[s.replyTo] != null) ? map[s.replyTo] : 0)),
        image: s.image || null,
      }))
      return { steps }
    }).filter((d) => d.steps.length > 0)

    if (cleanDialogs.length === 0) { setError('Заполните хотя бы один диалог (фейк + текст)'); return }

    setSubmitting(true)
    try {
      const payloadDialogs = await Promise.all(cleanDialogs.map(async (d) => ({
        steps: await Promise.all(d.steps.map(async (s) => ({
          profileUuid: s.profileUuid,
          text: s.text,
          replyTo: s.replyTo,
          image: s.image ? await varyImage(s.image) : null,
        }))),
      })))
      const { data } = await postTasks({ postUrl: url, dialogs: payloadDialogs })
      setTasks((data.tasks || []).map((t) => ({
        id: t.taskId,
        status: t.status,
        postUrl: t.postUrl,
        profileUuid: t.profileUuid,
        scheduledAt: t.scheduledAt,
        delayed: !!t.delayed,
        commentText: t.commentText,
        imageUrl: t.imageUrl,
      })))
    } catch (e) {
      setError(`Ошибка: ${e.response?.data?.error || e.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Запуск режима 2: один пост, несколько фейков, стаггер по времени.
  const startMode2 = async () => {
    setError('')
    const url = post2.trim()
    const list = entries
      .map((e) => ({ profileUuid: e.profileUuid, comment: (e.comment || '').trim(), image: e.image || null }))
      .filter((e) => e.profileUuid && e.comment)
    if (!url) { setError('Введите ссылку на пост'); return }
    if (list.length === 0) { setError('Добавьте хотя бы один фейк с комментарием'); return }

    setSubmitting(true)
    try {
      // По ОДНОМУ фейку за запрос: тело с N картинками рвёт туннель (502).
      // staggerIndex сохраняет разброс старта (первый сразу, остальные со сдвигом).
      let collected = []
      for (let i = 0; i < list.length; i += 1) {
        const e = list[i]
        const image = e.image ? await varyImage(e.image) : null
        const { data } = await postTasks({
          postUrl: url,
          entries: [{ profileUuid: e.profileUuid, commentText: e.comment, image }],
          staggerIndex: i,
        })
        collected = collected.concat(data.tasks || [])
      }
      setTasks(collected.map((t) => ({
        id: t.taskId,
        status: t.status,
        postUrl: t.postUrl,
        profileUuid: t.profileUuid,
        scheduledAt: t.scheduledAt,
        delayed: !!t.delayed,
        commentText: t.commentText,
        imageUrl: t.imageUrl,
      })))
    } catch (e) {
      setError(`Ошибка: ${e.response?.data?.error || e.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Режим 4: собрать страницы FB-переключателя выбранного админ-профиля.
  const refreshPages = async () => {
    if (!profileUuid) { setError('Сначала выберите админ-профиль'); return }
    setError(''); setCollectingPages(true); setCollectSeconds(0); setPages([])
    clearInterval(collectTimerRef.current)
    collectTimerRef.current = setInterval(() => setCollectSeconds((s) => s + 1), 1000)
    try {
      await axios.post(`${API_BASE}/api/pages/collect`, { profileUuid })
      // Бот открывает FB и читает переключатель — опрашиваем, пока не соберёт (до ~60с).
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 3000))
        const { data } = await axios.get(`${API_BASE}/api/pages/${profileUuid}`)
        if ((data.pages || []).length) { setPages(data.pages); break }
      }
    } catch (e) {
      setError(`Ошибка сбора страниц: ${e.response?.data?.error || e.message}`)
    } finally {
      clearInterval(collectTimerRef.current)
      setCollectingPages(false)
    }
  }

  // Режим 4: чистка — скрыть чужие комменты на посте от имени профиля-админа.
  const startMode4 = async () => {
    setError('')
    const url = post4.trim()
    if (!profileUuid) { setError('Выберите профиль-админ (тег Hide)'); return }
    if (!url) { setError('Введите ссылку на пост'); return }
    setSubmitting(true)
    try {
      const { data } = await axios.post(`${API_BASE}/api/hide`, { profileUuid, postUrl: url, pageName })
      setTasks((data.tasks || []).map((t) => ({
        id: t.taskId, status: t.status, postUrl: t.postUrl, profileUuid: t.profileUuid,
        scheduledAt: t.scheduledAt, commentText: t.commentText,
      })))
    } catch (e) {
      setError(`Ошибка: ${e.response?.data?.error || e.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Режим 4: наблюдение — загрузка списка/статуса, добавление, тумблер, удаление.
  const loadWatch = async () => {
    try {
      const { data } = await axios.get(`${API_BASE}/api/watch`)
      setWatchItems(data.items || [])
      setWatchScout(data.scout || null)
    } catch { /* пропустим */ }
  }
  const addWatch = async () => {
    setError('')
    const url = post4.trim()
    if (!profileUuid) { setError('Выберите профиль-админ (тег Hide)'); return }
    if (!url) { setError('Введите ссылку на пост'); return }
    setWatchBusy(true)
    try {
      await axios.post(`${API_BASE}/api/watch`, { profileUuid, postUrl: url, pageName })
      await loadWatch()
    } catch (e) {
      setError(`Ошибка: ${e.response?.data?.error || e.message}`)
    } finally {
      setWatchBusy(false)
    }
  }
  const toggleWatch = async (id, enabled) => {
    try { await axios.post(`${API_BASE}/api/watch/${id}/toggle`, { enabled }); await loadWatch() } catch { /* пропустим */ }
  }
  const removeWatch = async (id) => {
    try { await axios.delete(`${API_BASE}/api/watch/${id}`); await loadWatch() } catch { /* пропустим */ }
  }

  useEffect(() => {
    if (mode !== 4) return undefined
    // Первый забор — отложенно (не синхронно в теле эффекта, чтобы не было
    // каскадного setState), дальше опрос статуса раз в 15с.
    const t = setTimeout(loadWatch, 0)
    const id = setInterval(loadWatch, 15000)
    return () => { clearTimeout(t); clearInterval(id) }
  }, [mode])

  const startTask = async () => {
    if (mode === 4) { await startMode4(); return }
    if (mode === 3) { await startMode3(); return }
    if (mode === 2) { await startMode2(); return }
    setError('')
    const filled = posts
      .map((p, i) => ({ url: (p.url || '').trim(), i }))
      .filter((p) => p.url)
    if (!profileUuid) { setError('Выберите профиль'); return }
    if (filled.length === 0) { setError('Добавьте хотя бы одну ссылку на пост'); return }

    // Свой текст на каждый пост, если баер размножил поля; иначе — общий.
    const perMode = perComments.length > 0
    const commentFor = (idx) => (perMode ? (perComments[idx] ?? commentText) : commentText)
    if (perMode) {
      if (filled.some((it) => !commentFor(it.i).trim())) { setError('Заполни текст для каждого поста'); return }
    } else if (!commentText.trim()) { setError('Введите текст комментария'); return }

    setSubmitting(true)
    try {
      let collected = []
      if (opImage || perMode) {
        // По одному посту за запрос: из-за размера тела с картинками (иначе 502)
        // и чтобы у каждого поста ушёл свой текст.
        for (const it of filled) {
          const image = opImage ? await varyImage(opImage) : null
          const { data } = await postTasks({
            profileUuid, posts: [{ url: it.url, image }], commentText: commentFor(it.i),
          })
          collected = collected.concat(data.tasks || [])
        }
      } else {
        const { data } = await postTasks({
          profileUuid,
          posts: filled.map((it) => ({ url: it.url, image: null })),
          commentText,
        })
        collected = data.tasks || []
      }
      setTasks(collected.map((t) => ({
        id: t.taskId,
        status: t.status,
        postUrl: t.postUrl,
        profileUuid: t.profileUuid,
        scheduledAt: t.scheduledAt,
        delayed: !!t.delayed,
        commentText: t.commentText,
        imageUrl: t.imageUrl,
      })))
    } catch (e) {
      setError(`Ошибка: ${e.response?.data?.error || e.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Отмена операции: гасим выполняющиеся И снимаем запланированные.
  const cancelOperation = async () => {
    const ids = tasks.filter((t) => !isTerminal(t.status)).map((t) => t.id)
    if (!ids.length) return
    try {
      await axios.post(`${API_BASE}/api/tasks/cancel`, { ids })
      setTasks((ts) => ts.map((t) => (ids.includes(t.id) ? { ...t, status: 'canceled' } : t)))
    } catch (e) {
      setError(`Ошибка отмены: ${e.response?.data?.error || e.message}`)
    }
  }

  const isBusy = tasks.some((t) => !isTerminal(t.status))
  const hasProfiles = profiles.length > 0
  const canCancel = tasks.some((t) => !isTerminal(t.status))

  // Продолжить/повторить прямо в панели результатов операции (не только в Истории).
  const opDialogState = {}
  for (const t of tasks) {
    if (!t.dialogId) continue
    const d = opDialogState[t.dialogId] || (opDialogState[t.dialogId] = { hasError: false, hasPending: false })
    if (t.status === 'error') d.hasError = true
    if (t.status === 'queued' || t.status === 'running') d.hasPending = true
  }
  const opResumable = (dialogId) => !!(dialogId && opDialogState[dialogId]
    && opDialogState[dialogId].hasError && !opDialogState[dialogId].hasPending)

  const toPanelTask = (t) => ({
    id: t.id, status: t.status, postUrl: t.postUrl, profileUuid: t.profileUuid,
    scheduledAt: t.scheduledAt, commentText: t.commentText, imageUrl: t.imageUrl, dialogId: t.dialogId,
  })

  const opContinueDialog = async (dialogId) => {
    if (retrying[dialogId]) return
    setRetrying((r) => ({ ...r, [dialogId]: true }))
    try {
      const { data } = await axios.post(`${API_BASE}/api/dialog/continue`, { dialogId })
      const fresh = (data.created || []).map(toPanelTask)
      // Заменяем упавшие/отменённые шаги диалога СВЕЖИМИ на их же местах — без
      // перескока: вставляем на позицию первого не-DONE шага, остальные не-DONE убираем.
      setTasks((prev) => {
        let inserted = false
        const out = []
        for (const t of prev) {
          if (t.dialogId === dialogId && t.status !== 'done') {
            if (!inserted) { out.push(...fresh); inserted = true }
            continue
          }
          out.push(t)
        }
        if (!inserted) out.push(...fresh)
        return out
      })
    } catch (e) { setError(`Ошибка: ${e.response?.data?.error || e.message}`) } finally {
      setRetrying((r) => { const n = { ...r }; delete n[dialogId]; return n })
    }
  }
  const opRetryTask = async (id) => {
    if (retrying[id]) return
    setRetrying((r) => ({ ...r, [id]: true }))
    try {
      const { data } = await axios.post(`${API_BASE}/api/tasks/${id}/retry`)
      const t = data.task
      // Заменяем задачу НА ТОМ ЖЕ МЕСТЕ (новый id), чтобы карточка не прыгала.
      if (t) setTasks((prev) => prev.map((x) => (x.id === id ? toPanelTask(t) : x)))
    } catch (e) { setError(`Ошибка: ${e.response?.data?.error || e.message}`) } finally {
      setRetrying((r) => { const n = { ...r }; delete n[id]; return n })
    }
  }

  // Селект «тег + фейк» с фильтром по строке поиска (общий для режимов 2/3).
  const fakeSelect = (value, tag, searchStr, onTag, onFake) => (
    <>
      <select value={value} onChange={onFake} style={{ flex: 1, padding: '8px' }}>
        <option value="">— выберите фейк —</option>
        {entryProfiles(tag)
          .filter((p) => !searchStr || (p.title || '').toLowerCase().includes(String(searchStr).toLowerCase()))
          .map((p) => {
            const b = profileBusy(p.uuid)
            return <option key={p.uuid} value={p.uuid}>{p.flag ? `⚠️ ${flagLabel(p.flag.reason)} ` : ''}{p.title}{p.fbName ? ` · ${p.fbName}` : ''}{b ? ` — ${b}` : ''}</option>
          })}
      </select>
    </>
  )

  // Короткая подпись причины пометки ⚠️ (статус аккаунта из FB).
  const flagLabel = (reason) => (
    { checkpoint: 'проверка', disabled: 'бан', logout: 'разлогин', proxy: 'прокси', error: 'ошибка' }[reason] || 'проверка'
  )

  const clearFlag = async (uuid) => {
    try {
      await axios.post(`${API_BASE}/api/flags/clear`, { uuid })
      loadProfiles()
    } catch { /* пропустим */ }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
      {mode === 1 && (
      <>
      {loadingProfiles ? (
        <div className="tm-muted">Загрузка профилей Octo…</div>
      ) : hasProfiles ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              placeholder="Поиск профиля по названию"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="tm-icon-btn" onClick={loadProfiles} title="Обновить список профилей" style={{ width: '42px', flex: '0 0 auto' }}>
              <RefreshIcon />
            </button>
          </div>

          <div className="tm-list" role="listbox">
            {filteredProfiles.length === 0 && <div className="tm-list-empty">— Ничего не найдено —</div>}
            {filteredProfiles.map((p) => {
              const b = profileBusy(p.uuid)
              const sel = p.uuid === profileUuid
              return (
                <div
                  key={p.uuid}
                  className={`tm-list-item${sel ? ' active' : ''}`}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <span
                    role="option"
                    aria-selected={sel}
                    tabIndex={0}
                    onClick={() => setProfileUuid(p.uuid)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setProfileUuid(p.uuid) }}
                    style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {p.flag ? `⚠️ ${flagLabel(p.flag.reason)} ` : ''}{p.title}{p.tags && p.tags.length ? ` [${p.tags.join(', ')}]` : ''}
                    {p.fbName ? ` · 👤 ${p.fbName}` : ''}
                    {b ? ` — ⏳ ${b}` : ''}
                  </span>
                  {p.flag && (
                    <button
                      type="button"
                      className="tm-btn tm-btn-outline"
                      style={{ padding: '2px 8px', fontSize: '11px', flex: '0 0 auto' }}
                      title="Требует проверки в Octo (checkpoint). Пройди подтверждение под фейком и нажми «проверено»."
                      onClick={(e) => { e.stopPropagation(); clearFlag(p.uuid) }}
                    >
                      ✓ проверено
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {profileUuid && profileBusy(profileUuid) && (
            <div className="tm-warn" style={{ fontSize: '13px' }}>⏳ Этот фейк {profileBusy(profileUuid)}</div>
          )}

          <div className="tm-muted">Показано {filteredProfiles.length} из {source.length}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div className="tm-warn" style={{ fontSize: '14px' }}>Нет профилей с тегами {ALLOWED_TAGS.join(' / ')}.</div>
          {profilesError && <div className="tm-danger-text" style={{ fontSize: '12px' }}>{profilesError}</div>}
          <div><button type="button" className="tm-btn" onClick={loadProfiles}>Обновить список</button></div>
        </div>
      )}

      {/* Список постов */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button type="button" className="tm-btn tm-btn-outline" onClick={addPost} disabled={posts.length >= MAX_POSTS} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '18px', lineHeight: '1' }}>+</span>
            Добавить пост
          </button>
          <span className="tm-muted">{posts.length} / {MAX_POSTS}{posts.length >= MAX_POSTS ? ' — лимит на фейк' : ''}</span>
        </div>

        {posts.map((post, i) => (
          <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder={`Ссылка на пост Facebook${posts.length > 1 ? ` #${i + 1}` : ''}`}
              value={post.url}
              onChange={(e) => patchPost(i, { url: e.target.value })}
              style={{ flex: 1 }}
            />
            {posts.length > 1 && (
              <button type="button" className="tm-btn tm-btn-danger" onClick={() => removePost(i)} title="Удалить строку" style={{ width: '38px', height: '44px', flex: '0 0 auto', fontSize: '18px', padding: 0 }}>×</button>
            )}
          </div>
        ))}
      </div>

      {perComments.length === 0 ? (
        <>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
            <ImagePicker
              image={opImage}
              imageName={opImageName}
              onPick={pickOpImage}
              onClear={() => { setOpImage(null); setOpImageName('') }}
            />
            <textarea
              placeholder="Текст комментария (картинка слева — одна на все посты)"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              style={{ height: '100px', flex: 1 }}
            />
          </div>
          <div>
            <button
              type="button"
              className="tm-btn tm-btn-outline"
              disabled={!commentText.trim()}
              onClick={() => setPerComments(posts.map(() => commentText))}
              style={{ fontSize: '13px' }}
            >
              ⧉ Дублировать по постам ({posts.length})
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
            <ImagePicker
              image={opImage}
              imageName={opImageName}
              onPick={pickOpImage}
              onClear={() => { setOpImage(null); setOpImageName('') }}
            />
            <textarea
              placeholder="Текст для поста #1"
              value={perComments[0] || ''}
              onChange={(e) => setPerComments((arr) => arr.map((x, idx) => (idx === 0 ? e.target.value : x)))}
              style={{ height: '100px', flex: 1 }}
            />
          </div>
          {perComments.slice(1).map((c, k) => (
            <textarea
              key={k + 1}
              placeholder={`Текст для поста #${k + 2}`}
              value={c}
              onChange={(e) => setPerComments((arr) => arr.map((x, idx) => (idx === k + 1 ? e.target.value : x)))}
              style={{ height: '80px' }}
            />
          ))}
          <div>
            <button
              type="button"
              className="tm-btn tm-btn-outline"
              onClick={() => setPerComments([])}
              style={{ fontSize: '13px' }}
            >
              🗑 Удалить дубли (создать заново)
            </button>
          </div>
        </>
      )}
      </>
      )}

      {mode === 2 && (
      <>
        <input type="text" placeholder="Ссылка на пост Facebook" value={post2} onChange={(e) => setPost2(e.target.value)} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>
            <button type="button" className="tm-btn tm-btn-outline" onClick={addEntry} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '18px', lineHeight: '1' }}>+</span>
              Добавить фейк
            </button>
          </div>

          {loadingProfiles && <div className="tm-muted">Загрузка профилей Octo…</div>}

          {entries.map((en, i) => (
            <div key={i} className="tm-card" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <input
                type="text"
                placeholder="Поиск фейка по названию"
                value={en.search || ''}
                onChange={(e) => patchEntry(i, { search: e.target.value })}
              />
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                {fakeSelect(
                  en.profileUuid,
                  en.tag,
                  en.search,
                  (e) => patchEntry(i, { tag: e.target.value, profileUuid: '' }),
                  (e) => patchEntry(i, { profileUuid: e.target.value }),
                )}
                <ImagePicker
                  image={en.image}
                  imageName={en.imageName}
                  onPick={(f) => pickEntryImage(i, f)}
                  onClear={() => patchEntry(i, { image: null, imageName: '' })}
                />
                {entries.length > 1 && (
                  <button type="button" className="tm-btn tm-btn-danger" onClick={() => removeEntry(i)} title="Удалить фейк" style={{ width: '38px', height: '44px', flex: '0 0 auto', fontSize: '18px', padding: 0 }}>×</button>
                )}
              </div>
              <textarea placeholder="Комментарий этого фейка" value={en.comment} onChange={(e) => patchEntry(i, { comment: e.target.value })} style={{ height: '60px' }} />
            </div>
          ))}
        </div>
      </>
      )}

      {mode === 3 && (
      <>
        <input type="text" placeholder="Ссылка на пост Facebook" value={post3} onChange={(e) => setPost3(e.target.value)} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <button type="button" className="tm-btn tm-btn-outline" onClick={addDialog} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '18px', lineHeight: '1' }}>+</span>
              Добавить диалог
            </button>
          </div>

          {loadingProfiles && <div className="tm-muted">Загрузка профилей Octo…</div>}

          {dialogs.map((d, di) => (
            <div key={di} className="tm-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <strong style={{ fontSize: '14px' }}>Диалог {di + 1}</strong>
                {dialogs.length > 1 && (
                  <button type="button" className="tm-btn tm-btn-danger" onClick={() => removeDialog(di)} title="Удалить диалог" style={{ fontSize: '12px', padding: '3px 10px' }}>удалить диалог</button>
                )}
              </div>

              {d.steps.map((s, si) => (
                <div key={si} className="tm-subcard" style={{ marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <input
                    type="text"
                    placeholder={`Поиск фейка (реплика ${si + 1})`}
                    value={s.search || ''}
                    onChange={(e) => patchStep(di, si, { search: e.target.value })}
                  />
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span className="tm-muted" style={{ flex: '0 0 auto' }}>{si + 1}.</span>
                    {fakeSelect(
                      s.profileUuid,
                      s.tag,
                      s.search,
                      (e) => patchStep(di, si, { tag: e.target.value, profileUuid: '' }),
                      (e) => patchStep(di, si, { profileUuid: e.target.value }),
                    )}
                    <ImagePicker
                      image={s.image}
                      imageName={s.imageName}
                      size={40}
                      onPick={(f) => pickStepImage(di, si, f)}
                      onClear={() => patchStep(di, si, { image: null, imageName: '' })}
                    />
                    {d.steps.length > 1 && (
                      <button type="button" className="tm-btn tm-btn-danger" onClick={() => removeStep(di, si)} title="Удалить реплику" style={{ width: '34px', height: '40px', flex: '0 0 auto', fontSize: '16px', padding: 0 }}>×</button>
                    )}
                  </div>

                  {si > 0 && (
                    <div className="tm-muted" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      отвечает на:
                      <select value={s.replyTo != null ? s.replyTo : 0} onChange={(e) => patchStep(di, si, { replyTo: Number(e.target.value) })} style={{ padding: '4px 8px' }}>
                        {d.steps.slice(0, si).map((_, k) => (
                          <option key={k} value={k}>
                            {`на реплику ${k + 1}${k === 0 ? ' (верхний коммент)' : ''}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <textarea placeholder={si === 0 ? 'Верхний комментарий' : 'Текст ответа'} value={s.text} onChange={(e) => patchStep(di, si, { text: e.target.value })} style={{ height: '54px' }} />
                </div>
              ))}

              <button type="button" className="tm-btn tm-btn-outline" onClick={() => addStep(di)} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '7px 12px' }}>
                <span style={{ fontSize: '16px', lineHeight: '1' }}>+</span>
                Добавить реплику
              </button>
            </div>
          ))}
        </div>
      </>
      )}

      {mode === 4 && (
      <>
        <input
          type="text"
          placeholder="Поиск админа по названию"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={profileUuid} onChange={(e) => setProfileUuid(e.target.value)} style={{ padding: '8px' }}>
          <option value="">— выберите админа (тег Hide) —</option>
          {adminProfiles
            .filter((p) => !search || (p.title || '').toLowerCase().includes(search.toLowerCase()))
            .map((p) => (
              <option key={p.uuid} value={p.uuid}>
                {p.flag ? `⚠️ ${flagLabel(p.flag.reason)} ` : ''}{p.title}{p.fbName ? ` · ${p.fbName}` : ''}
              </option>
            ))}
        </select>
        {loadingProfiles && <div className="tm-muted">Загрузка профилей Octo…</div>}
        {!loadingProfiles && adminProfiles.length === 0 && (
          <div className="tm-muted" style={{ fontSize: '12px' }}>
            Нет профилей с тегом «Hide». Присвой админ-страницам тег Hide в Octo.
          </div>
        )}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <select value={pageName} onChange={(e) => setPageName(e.target.value)} style={{ flex: 1, padding: '8px' }}>
            <option value="">— страница (от чьего имени скрывать) —</option>
            {pages.map((p) => (
              <option key={p.id || p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="tm-btn tm-btn-outline"
            onClick={refreshPages}
            disabled={collectingPages || !profileUuid}
            title="Открыть FB этим профилем и собрать список его страниц из переключателя"
            style={{ flex: '0 0 auto', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
          >
            {collectingPages && (
              <span
                aria-hidden
                style={{
                  width: 14, height: 14, borderRadius: '50%', flex: '0 0 auto',
                  border: '2px solid var(--muted)', borderTopColor: 'transparent',
                  display: 'inline-block', animation: 'tmspin 0.8s linear infinite',
                }}
              />
            )}
            {collectingPages ? `Собираю… ${collectSeconds}с` : '🔄 Обновить страницы'}
          </button>
          <style>{'@keyframes tmspin{to{transform:rotate(360deg)}}'}</style>
        </div>
        {collectingPages && (
          <div className="tm-muted" style={{ fontSize: '12px' }}>
            Бот открывает Facebook этим профилем и читает переключатель страниц… (~20–40 сек)
          </div>
        )}
        <input type="text" placeholder="Ссылка на пост Facebook" value={post4} onChange={(e) => setPost4(e.target.value)} />
        <p className="tm-muted" style={{ fontSize: '12px', margin: 0 }}>
          Скрывает ЧУЖИЕ комментарии на посте от имени выбранного админа. Комментарии
          наших фейков (по вайт-листу) не трогает. Пауза 1–2 сек между скрытиями.
        </p>
        <button
          type="button"
          className="tm-btn tm-btn-outline"
          onClick={addWatch}
          disabled={watchBusy || !profileUuid}
          title="Добавить пост в наблюдение: бот сам будет находить и скрывать новые чужие комментарии"
        >
          {watchBusy ? 'Добавляю…' : '➕ В наблюдение (авто-чистка)'}
        </button>

        {watchItems.length > 0 && (
          <div className="tm-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '13px' }}>Наблюдение · авто-чистка</strong>
              <span className="tm-muted" style={{ fontSize: '11px' }}>
                Скаут: {watchScout ? (watchScout.available ? 'ок' : 'нет свободного профиля') : '—'}
              </span>
            </div>
            {watchItems.map((w) => (
              <div key={w.id} style={{ display: 'flex', flexDirection: 'column', gap: '2px', borderTop: '1px solid var(--border)', paddingTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                  <a className="tm-link" href={w.postUrl} target="_blank" rel="noreferrer" style={{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.postUrl}</a>
                  <div style={{ display: 'flex', gap: '6px', flex: '0 0 auto' }}>
                    <button type="button" className="tm-btn tm-btn-outline" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={() => toggleWatch(w.id, !w.enabled)}>
                      {w.enabled ? '⏸ Выкл' : '▶ Вкл'}
                    </button>
                    <button type="button" className="tm-btn tm-btn-outline" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={() => removeWatch(w.id)} title="Убрать из наблюдения">✕</button>
                  </div>
                </div>
                <span className="tm-muted" style={{ fontSize: '11px' }}>
                  Страница: {w.pageName || '—'} · {w.enabled ? 'вкл' : 'выкл'}
                  {w.lastCheckAt ? ` · проверен ${new Date(w.lastCheckAt).toLocaleTimeString()}` : ' · ещё не проверялся'}
                  {w.enabled && w.lastCheckAt && w.periodMs ? ` · след. ~${new Date(new Date(w.lastCheckAt).getTime() + w.periodMs).toLocaleTimeString()}` : ''}
                  {w.lastCleanAt ? ` · чистка ${new Date(w.lastCleanAt).toLocaleTimeString()} (скрыто ${w.lastHidden})` : ''}
                </span>
                {w.lastError && <span className="tm-danger-text" style={{ fontSize: '11px' }}>{w.lastError}</span>}
              </div>
            ))}
          </div>
        )}
      </>
      )}

      <button className="tm-btn tm-btn-primary" onClick={startTask} disabled={submitting || isBusy}>
        {submitting ? 'Отправка…' : isBusy ? 'Выполняется…' : (mode === 4 ? 'Очистить' : 'Запустить')}
      </button>

      {error && <p className="tm-danger-text" style={{ fontWeight: 'bold', margin: 0 }}>{error}</p>}

      {/* Короткий итог по каждому посту — без логов */}
      {tasks.map((task) => (
        <div key={task.id} className="tm-card" style={{ display: 'flex', gap: '10px' }}>
          {task.imageUrl ? (
            <img src={`${API_BASE}${task.imageUrl}`} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, flex: '0 0 auto' }} />
          ) : (
            <div style={{ width: 48, height: 48, flex: '0 0 auto' }} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <a className="tm-link" href={task.postUrl} target="_blank" rel="noreferrer" style={{ fontSize: '12px' }}>{task.postUrl}</a>
              <span style={{ fontWeight: 'bold', color: STATUS_COLORS[task.status] || 'var(--fg)', flex: '0 0 auto' }}>
                {taskStatusText(task)}
              </span>
            </div>
            {task.profileUuid && <span className="tm-muted" style={{ fontSize: '11px' }}>Фейк: {profileTitle(task.profileUuid)}</span>}
            {task.commentText && <div style={{ fontSize: '13px' }}>{task.commentText}</div>}
            {task.status === 'error' && task.error && <span className="tm-danger-text" style={{ fontSize: '12px' }}>{task.error}</span>}
            {task.status === 'error' && task.dialogId && opResumable(task.dialogId) && (
              <div>
                <button
                  type="button"
                  className="tm-btn tm-btn-outline"
                  style={{ fontSize: '12px', padding: '2px 10px' }}
                  title="Пересоздать этот шаг и все последующие реплики диалога и доиграть ветку"
                  disabled={!!retrying[task.dialogId]}
                  onClick={() => opContinueDialog(task.dialogId)}
                >
                  ▶ Продолжить диалог
                </button>
              </div>
            )}
            {(task.status === 'error' || task.status === 'canceled') && !task.dialogId && (
              <div>
                <button
                  type="button"
                  className="tm-btn tm-btn-outline"
                  style={{ fontSize: '12px', padding: '2px 10px' }}
                  title="Пересоздать эту задачу и выполнить заново"
                  disabled={!!retrying[task.id]}
                  onClick={() => opRetryTask(task.id)}
                >
                  ↻ Повторить ещё раз
                </button>
              </div>
            )}
          </div>
        </div>
      ))}

      {canCancel && (
        <button type="button" className="tm-btn tm-btn-danger" onClick={cancelOperation}>Отменить операцию</button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// История и текущий прогресс: все задачи (пост, фейк, коммент, картинка,
// время, статус). Тянет /api/tasks раз в 3с.
// ─────────────────────────────────────────────────────────────────────────
function History({ profiles }) {
  const [tasks, setTasks] = useState([])
  const [retrying, setRetrying] = useState({})
  const nameOf = (uuid) => {
    const p = profiles.find((x) => x.uuid === uuid)
    return p ? p.title : (uuid ? `${uuid.slice(0, 8)}…` : '—')
  }

  useEffect(() => {
    let active = true
    const fetchTasks = async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/api/tasks`)
        if (active) setTasks(data.tasks || [])
      } catch { /* пропустим тик */ }
    }
    fetchTasks()
    const id = setInterval(fetchTasks, 3000)
    return () => { active = false; clearInterval(id) }
  }, [])

  const timeInfo = (t) => {
    if (t.status === 'done') return `оставлен ${fmtDateTime(t.finishedAt)}`
    if (t.status === 'running') return `выполняется, старт ${fmtDateTime(t.startedAt)}`
    if (t.status === 'error') return `ошибка ${fmtDateTime(t.finishedAt)}`
    if (t.status === 'canceled') return `отменён ${fmtDateTime(t.finishedAt || t.scheduledAt)}`
    return `запланирован на ${fmtDateTime(t.scheduledAt)}`
  }

  const sorted = [...tasks].sort((a, b) => (b.scheduledAt || 0) - (a.scheduledAt || 0))

  // Оборванный диалог = есть упавший шаг И нет активных (queued/running) — можно
  // продолжить. Считаем состояние по dialogId.
  const dialogState = {}
  for (const t of tasks) {
    if (!t.dialogId) continue
    const d = dialogState[t.dialogId] || (dialogState[t.dialogId] = { hasError: false, hasPending: false })
    if (t.status === 'error') d.hasError = true
    if (t.status === 'queued' || t.status === 'running') d.hasPending = true
  }
  const resumable = (dialogId) => !!(dialogId && dialogState[dialogId] && dialogState[dialogId].hasError && !dialogState[dialogId].hasPending)

  const continueDialog = async (dialogId) => {
    if (retrying[dialogId]) return
    setRetrying((r) => ({ ...r, [dialogId]: true }))
    try { await axios.post(`${API_BASE}/api/dialog/continue`, { dialogId }) } catch { /* пропустим */ } finally {
      setTimeout(() => setRetrying((r) => { const n = { ...r }; delete n[dialogId]; return n }), 2500)
    }
  }
  const retryTask = async (id) => {
    if (retrying[id]) return
    setRetrying((r) => ({ ...r, [id]: true }))
    try { await axios.post(`${API_BASE}/api/tasks/${id}/retry`) } catch { /* пропустим */ } finally {
      setTimeout(() => setRetrying((r) => { const n = { ...r }; delete n[id]; return n }), 2500)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {sorted.length === 0 && <div className="tm-muted">Пока нет задач.</div>}
      {sorted.map((t) => (
        <div key={t.id} className="tm-card" style={{ display: 'flex', gap: '10px' }}>
          {t.imageUrl ? (
            <img src={`${API_BASE}${t.imageUrl}`} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, flex: '0 0 auto' }} />
          ) : (
            <div style={{ width: 48, height: 48, flex: '0 0 auto' }} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
              <a className="tm-link" href={t.postUrl} target="_blank" rel="noreferrer" style={{ fontSize: '12px' }}>{t.postUrl}</a>
              <span style={{ fontWeight: 'bold', color: STATUS_COLORS[t.status] || 'var(--fg)', flex: '0 0 auto' }}>{taskStatusText(t)}</span>
            </div>
            <div className="tm-muted">Фейк: {nameOf(t.profileUuid)} · {timeInfo(t)}</div>
            {t.commentText && <div style={{ fontSize: '13px' }}>{t.commentText}</div>}
            {t.status === 'error' && t.error && <div className="tm-danger-text" style={{ fontSize: '12px' }}>{t.error}</div>}
            {t.status === 'error' && t.dialogId && resumable(t.dialogId) && (
              <div>
                <button
                  type="button"
                  className="tm-btn tm-btn-outline"
                  style={{ fontSize: '12px', padding: '2px 10px' }}
                  title="Пересоздать этот шаг и все последующие реплики диалога и доиграть ветку"
                  disabled={!!retrying[t.dialogId]}
                  onClick={() => continueDialog(t.dialogId)}
                >
                  ▶ Продолжить диалог
                </button>
              </div>
            )}
            {(t.status === 'error' || t.status === 'canceled') && !t.dialogId && (
              <div>
                <button
                  type="button"
                  className="tm-btn tm-btn-outline"
                  style={{ fontSize: '12px', padding: '2px 10px' }}
                  title="Пересоздать эту задачу и выполнить заново"
                  disabled={!!retrying[t.id]}
                  onClick={() => retryTask(t.id)}
                >
                  ↻ Повторить ещё раз
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Корень: вкладки-операции + общие профили и таймеры занятости фейков.
// ─────────────────────────────────────────────────────────────────────────
function App() {
  const [authReady, setAuthReady] = useState(false)
  const [profiles, setProfiles] = useState([])
  const [profilesError, setProfilesError] = useState('')
  const [loadingProfiles, setLoadingProfiles] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState({})
  const [busyAt, setBusyAt] = useState(() => Date.now())

  const [activeMode, setActiveMode] = useState(() => {
    try {
      const v = localStorage.getItem('octobot:activeMode')
      if (v === 'history') return 'history'
      const n = Number(v)
      return (n === 1 || n === 2 || n === 3) ? n : 1
    } catch { return 1 }
  })
  // Черновики операций теперь хранятся на СЕРВЕРЕ (надёжно, без квоты и изоляции
  // iframe). drafts = карта { 'tabs': {...}, 'op:<m>:<id>': {...} }. Пока не
  // загрузились — не монтируем операции (иначе они стартанут с пустого состояния).
  const [drafts, setDrafts] = useState(null)
  // Двухуровневая структура вкладок: офферы, внутри — операции. Хранится на сервере.
  const [struct, setStruct] = useState(defaultOffers)
  const structSaveTimer = useRef(null)
  const structHydrated = useRef(false)

  useEffect(() => {
    let alive = true
    axios.get(`${API_BASE}/api/drafts`).then(({ data }) => {
      if (!alive) return
      const items = (data && data.items) || {}
      setStruct(migrateStruct(items.tabs))
      structHydrated.current = true
      setDrafts(items)
    }).catch(() => { structHydrated.current = true; setDrafts({}) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!structHydrated.current) return undefined // не перетираем серверную структуру до загрузки
    clearTimeout(structSaveTimer.current)
    structSaveTimer.current = setTimeout(() => {
      axios.put(`${API_BASE}/api/drafts/tabs`, struct).catch(() => {})
    }, 500)
    return () => clearTimeout(structSaveTimer.current)
  }, [struct])

  // Запоминаем активную вкладку режима, чтобы не слетала при обновлении страницы.
  useEffect(() => {
    try { localStorage.setItem('octobot:activeMode', String(activeMode)) } catch { /* ignore */ }
  }, [activeMode])

  const loadProfiles = async () => {
    setLoadingProfiles(true)
    setProfilesError('')
    try {
      const { data } = await axios.get(`${API_BASE}/api/profiles`)
      setProfiles(data.profiles || [])
      if (data.error) setProfilesError(data.error)
    } catch (e) {
      setProfilesError(e.response?.data?.error || e.message)
    } finally {
      setLoadingProfiles(false)
    }
  }

  // Дожидаемся SSO-рукопожатия перед любыми запросами (иначе кука ещё не стоит).
  useEffect(() => {
    let active = true
    ssoReady.finally(() => { if (active) setAuthReady(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!authReady) return undefined
    let active = true
    axios.get(`${API_BASE}/api/profiles`)
      .then(({ data }) => {
        if (!active) return
        setProfiles(data.profiles || [])
        if (data.error) setProfilesError(data.error)
      })
      .catch((e) => { if (active) setProfilesError(e.response?.data?.error || e.message) })
      .finally(() => { if (active) setLoadingProfiles(false) })
    return () => { active = false }
  }, [authReady])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!authReady) return undefined
    let active = true
    const fetchBusy = async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/api/busy`)
        if (!active) return
        setBusy(data.busy || {})
        setBusyAt(Date.now())
      } catch { /* пропустим тик */ }
    }
    fetchBusy()
    const id = setInterval(fetchBusy, 3000)
    return () => { active = false; clearInterval(id) }
  }, [authReady])

  const activeOfferObj = (m) => struct.offers[m].find((o) => o.id === struct.activeOffer[m]) || struct.offers[m][0]

  // ---- Офферы ----
  const addOffer = (m) => setStruct((prev) => {
    const id = prev.nextOfferId[m]; const opId = prev.nextOpId[m]
    return {
      ...prev,
      offers: { ...prev.offers, [m]: [...prev.offers[m], { id, name: `Оффер ${prev.offers[m].length + 1}`, ops: [{ id: opId, name: 'Операция 1' }], activeOp: opId }] },
      activeOffer: { ...prev.activeOffer, [m]: id },
      nextOfferId: { ...prev.nextOfferId, [m]: id + 1 },
      nextOpId: { ...prev.nextOpId, [m]: opId + 1 },
    }
  })
  const activateOffer = (m, offerId) => setStruct((prev) => ({ ...prev, activeOffer: { ...prev.activeOffer, [m]: offerId } }))
  const renameOffer = (m, offerId, name) => setStruct((prev) => ({
    ...prev, offers: { ...prev.offers, [m]: prev.offers[m].map((o) => (o.id === offerId ? { ...o, name } : o)) },
  }))
  const closeOffer = (m, offerId) => {
    const list = struct.offers[m]
    if (list.length <= 1) return
    const closed = list.find((o) => o.id === offerId)
    if (closed) {
      for (const op of closed.ops) axios.delete(`${API_BASE}/api/drafts/op:${m}:${op.id}`).catch(() => {})
      setDrafts((prev) => { if (!prev) return prev; const n = { ...prev }; for (const op of closed.ops) delete n[`op:${m}:${op.id}`]; return n })
    }
    setStruct((prev) => {
      const l = prev.offers[m]; const idx = l.findIndex((o) => o.id === offerId); const next = l.filter((o) => o.id !== offerId)
      if (!next.length) return prev
      const activeOffer = prev.activeOffer[m] === offerId
        ? { ...prev.activeOffer, [m]: (next[idx] || next[next.length - 1]).id } : prev.activeOffer
      return { ...prev, offers: { ...prev.offers, [m]: next }, activeOffer }
    })
  }

  // Дублировать активный оффер вместе со ВСЕМИ его операциями (поля/картинки), но
  // БЕЗ логов. Каждой операции — новый id и своя копия черновика на сервере.
  const duplicateOffer = async (m) => {
    const src = struct.offers[m].find((o) => o.id === struct.activeOffer[m])
    if (!src) return
    let items = drafts || {}
    try {
      const { data: r } = await axios.get(`${API_BASE}/api/drafts`)
      if (r && r.items) items = r.items
    } catch { /* из кэша */ }
    const newOfferId = struct.nextOfferId[m]
    let nextOp = struct.nextOpId[m]
    const newOps = []
    const cache = {}
    for (const op of src.ops) {
      const newOpId = nextOp; nextOp += 1
      const copy = { ...(items[`op:${m}:${op.id}`] || {}), tasks: [] }
      try { await axios.put(`${API_BASE}/api/drafts/op:${m}:${newOpId}`, copy) } catch { /* пропустим */ }
      cache[`op:${m}:${newOpId}`] = copy
      newOps.push({ id: newOpId, name: op.name })
    }
    setDrafts((prev) => ({ ...(prev || {}), ...cache }))
    setStruct((prev) => ({
      ...prev,
      offers: { ...prev.offers, [m]: [...prev.offers[m], { id: newOfferId, name: `${src.name} (копия)`, ops: newOps, activeOp: newOps.length ? newOps[0].id : prev.nextOpId[m] }] },
      activeOffer: { ...prev.activeOffer, [m]: newOfferId },
      nextOfferId: { ...prev.nextOfferId, [m]: newOfferId + 1 },
      nextOpId: { ...prev.nextOpId, [m]: Math.max(prev.nextOpId[m], nextOp) },
    }))
  }

  // ---- Операции (внутри активного оффера) ----
  const addOp = (m) => setStruct((prev) => {
    const opId = prev.nextOpId[m]; const offerId = prev.activeOffer[m]
    return {
      ...prev,
      offers: { ...prev.offers, [m]: prev.offers[m].map((o) => (o.id === offerId ? { ...o, ops: [...o.ops, { id: opId, name: `Операция ${o.ops.length + 1}` }], activeOp: opId } : o)) },
      nextOpId: { ...prev.nextOpId, [m]: opId + 1 },
    }
  })
  const activateOp = (m, opId) => setStruct((prev) => {
    const offerId = prev.activeOffer[m]
    return { ...prev, offers: { ...prev.offers, [m]: prev.offers[m].map((o) => (o.id === offerId ? { ...o, activeOp: opId } : o)) } }
  })
  const renameOp = (m, opId, name) => setStruct((prev) => {
    const offerId = prev.activeOffer[m]
    return { ...prev, offers: { ...prev.offers, [m]: prev.offers[m].map((o) => (o.id === offerId ? { ...o, ops: o.ops.map((op) => (op.id === opId ? { ...op, name } : op)) } : o)) } }
  })
  const closeOp = (m, opId) => {
    const offerId = struct.activeOffer[m]
    const offer = struct.offers[m].find((o) => o.id === offerId)
    if (!offer || offer.ops.length <= 1) return
    axios.delete(`${API_BASE}/api/drafts/op:${m}:${opId}`).catch(() => {})
    setDrafts((prev) => { if (!prev) return prev; const n = { ...prev }; delete n[`op:${m}:${opId}`]; return n })
    setStruct((prev) => ({
      ...prev,
      offers: { ...prev.offers, [m]: prev.offers[m].map((o) => {
        if (o.id !== offerId) return o
        const idx = o.ops.findIndex((x) => x.id === opId); const next = o.ops.filter((x) => x.id !== opId)
        const activeOp = o.activeOp === opId ? (next[idx] || next[next.length - 1]).id : o.activeOp
        return { ...o, ops: next, activeOp }
      }) },
    }))
  }
  // Дублировать активную операцию: копируем все её поля/картинки, но БЕЗ логов.
  const duplicateOp = async (m) => {
    const offerId = struct.activeOffer[m]
    const offer = struct.offers[m].find((o) => o.id === offerId)
    if (!offer) return
    const srcOpId = offer.activeOp
    const srcKey = `op:${m}:${srcOpId}`
    let data = (drafts && drafts[srcKey]) || {}
    try {
      const { data: r } = await axios.get(`${API_BASE}/api/drafts`)
      if (r && r.items && r.items[srcKey]) data = r.items[srcKey]
    } catch { /* из кэша */ }
    const newOpId = struct.nextOpId[m]
    const copy = { ...data, tasks: [] }
    try { await axios.put(`${API_BASE}/api/drafts/op:${m}:${newOpId}`, copy) } catch { /* пропустим */ }
    setDrafts((prev) => ({ ...(prev || {}), [`op:${m}:${newOpId}`]: copy }))
    const srcName = (offer.ops.find((x) => x.id === srcOpId) || {}).name || 'Операция'
    setStruct((prev) => ({
      ...prev,
      offers: { ...prev.offers, [m]: prev.offers[m].map((o) => (o.id === offerId ? { ...o, ops: [...o.ops, { id: newOpId, name: `${srcName} (копия)` }], activeOp: newOpId } : o)) },
      nextOpId: { ...prev.nextOpId, [m]: Math.max(prev.nextOpId[m], newOpId + 1) },
    }))
  }

  const MODES = [
    { m: 1, label: 'один фейк → много постов' },
    { m: 2, label: 'один пост → много фейков' },
    { m: 3, label: 'диалоги (дерево)' },
    { m: 4, label: 'чистка (скрыть чужих)' },
  ]

  if (!IS_EMBEDDED && !IS_LOCAL) {
    return (
      <div style={{ maxWidth: '560px', margin: '80px auto', padding: '24px', textAlign: 'center', color: 'var(--muted)' }}>
        Этот инструмент доступен только из рабочего кабинета.
      </div>
    )
  }

  if (!authReady || drafts === null) {
    return (
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '34px 24px', color: 'var(--muted)' }}>
        Загрузка…
      </div>
    )
  }

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '34px 24px 64px' }}>
      {/* Верхний уровень — вкладки: режимы + история */}
      <div className="tm-tabs tm-tabs-top" style={{ marginBottom: '18px' }}>
        {MODES.map(({ m, label }) => (
          <div
            key={m}
            role="button"
            tabIndex={0}
            className={`tm-tab${activeMode === m ? ' active' : ''}`}
            onClick={() => setActiveMode(m)}
            onKeyDown={(e) => { if (e.key === 'Enter') setActiveMode(m) }}
          >
            {label}
          </div>
        ))}
        <div
          role="button"
          tabIndex={0}
          className={`tm-tab${activeMode === 'history' ? ' active' : ''}`}
          onClick={() => setActiveMode('history')}
          onKeyDown={(e) => { if (e.key === 'Enter') setActiveMode('history') }}
        >
          История и прогресс
        </div>
      </div>

      {/* Под каждым режимом — офферы (верхний ряд) → операции активного оффера */}
      {MODES.map(({ m }) => {
        const offer = activeOfferObj(m)
        return (
          <div key={m} style={{ display: activeMode === m ? 'block' : 'none' }}>
            {/* Офферы */}
            <div className="tm-tabs">
              {struct.offers[m].map((o) => (
                <EditableTab
                  key={o.id}
                  label={o.name}
                  active={o.id === struct.activeOffer[m]}
                  onActivate={() => activateOffer(m, o.id)}
                  onRename={(n) => renameOffer(m, o.id, n)}
                  onClose={() => closeOffer(m, o.id)}
                  closable={struct.offers[m].length > 1}
                />
              ))}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginLeft: '4px', marginBottom: '2px' }}>
                <button
                  type="button"
                  className="tm-add-tab"
                  onClick={() => addOffer(m)}
                  title="Новый оффер (пустой)"
                  style={{ width: '48px', height: '17px', fontSize: '15px', lineHeight: 1, padding: 0 }}
                >
                  +
                </button>
                <button
                  type="button"
                  className="tm-add-tab"
                  onClick={() => duplicateOffer(m)}
                  title="Дублировать оффер (все операции, без логов)"
                  style={{ width: '48px', height: '17px', fontSize: '13px', lineHeight: 1, padding: 0 }}
                >
                  ⧉
                </button>
              </div>
            </div>

            {/* Операции активного оффера */}
            <div className="tm-tabs" style={{ marginTop: '6px' }}>
              {offer.ops.map((op) => (
                <EditableTab
                  key={op.id}
                  label={op.name}
                  active={op.id === offer.activeOp}
                  onActivate={() => activateOp(m, op.id)}
                  onRename={(n) => renameOp(m, op.id, n)}
                  onClose={() => closeOp(m, op.id)}
                  closable={offer.ops.length > 1}
                />
              ))}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginLeft: '4px', marginBottom: '2px' }}>
                <button
                  type="button"
                  className="tm-add-tab"
                  onClick={() => addOp(m)}
                  title="Новая операция (пустая)"
                  style={{ width: '48px', height: '17px', fontSize: '15px', lineHeight: 1, padding: 0 }}
                >
                  +
                </button>
                <button
                  type="button"
                  className="tm-add-tab"
                  onClick={() => duplicateOp(m)}
                  title="Дублировать операцию (все поля, без логов)"
                  style={{ width: '48px', height: '17px', fontSize: '13px', lineHeight: 1, padding: 0 }}
                >
                  ⧉
                </button>
              </div>
            </div>

            {offer.ops.map((op) => (
              <div key={`${offer.id}:${op.id}`} style={{ display: offer.activeOp === op.id ? 'block' : 'none' }}>
                <Operation
                  mode={m}
                  opId={op.id}
                  initial={drafts[`op:${m}:${op.id}`] || {}}
                  profiles={profiles}
                  loadingProfiles={loadingProfiles}
                  profilesError={profilesError}
                  loadProfiles={loadProfiles}
                  busy={busy}
                  busyAt={busyAt}
                  now={now}
                />
              </div>
            ))}
          </div>
        )
      })}

      {/* Вкладка «История и прогресс» */}
      <div style={{ display: activeMode === 'history' ? 'block' : 'none' }}>
        <History profiles={profiles} />
      </div>
    </div>
  )
}

export default App
