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

// Максимум операций (вкладок) в каждом режиме.
const MAX_OPS = 10

// Человечная вариация картинки: лёгкий рекадр/фильтр/пересохранение — как
// естественный ре-шер, а не «невидимый шум». Меняет отпечаток, выглядит живо.
function varyImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const W = img.naturalWidth
      const H = img.naturalHeight
      if (!W || !H) { resolve(dataUrl); return }
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
      const MAX_DIM = 1280
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
      resolve(canvas.toDataURL('image/jpeg', rnd(0.78, 0.82)))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
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
          <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
  mode, profiles, loadingProfiles, profilesError, loadProfiles, busy, busyAt, now,
}) {
  const [profileUuid, setProfileUuid] = useState('')
  const [posts, setPosts] = useState([{ url: '', image: null, imageName: '' }])
  const [commentText, setCommentText] = useState('')
  const [tasks, setTasks] = useState([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  // Режим 2: один пост -> много фейков (каждый со своим тегом/фейком/комментом/картинкой).
  const [post2, setPost2] = useState('')
  const [entries, setEntries] = useState([{
    profileUuid: '', tag: '', search: '', comment: '', image: null, imageName: '',
  }])
  // Режим 3: диалоги. dialogs[].steps[] = { profileUuid, tag, text, replyTo, image }.
  const [post3, setPost3] = useState('')
  const newStep = (replyTo = null) => ({
    profileUuid: '', tag: '', search: '', text: '', replyTo, image: null, imageName: '',
  })
  const [dialogs, setDialogs] = useState([{ steps: [newStep(null)] }])
  const pollRef = useRef(null)

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

  const allTags = Array.from(new Set(profiles.flatMap((p) => p.tags || []))).sort()
  const baseProfiles = profiles.filter((p) => (p.tags || []).some(isAllowedTag))
  const source = tagFilter
    ? profiles.filter((p) => (p.tags || []).includes(tagFilter))
    : baseProfiles
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
  const addPost = () => setPosts((p) => (p.length >= MAX_POSTS ? p : [...p, { url: '', image: null, imageName: '' }]))
  const removePost = (i) => setPosts((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)))

  const pickImage = (i, file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => patchPost(i, { image: reader.result, imageName: file.name })
    reader.readAsDataURL(file)
  }
  const applyImageToAll = (src, name) => setPosts((p) => p.map((x) => ({ ...x, image: src, imageName: name })))

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
    reader.onload = () => patchEntry(i, { image: reader.result, imageName: file.name })
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
    reader.onload = () => patchStep(di, si, { image: reader.result, imageName: file.name })
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
        replyTo: ni === 0 ? null : (s.replyTo != null && map[s.replyTo] != null ? map[s.replyTo] : 0),
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
      const { data } = await axios.post(`${API_BASE}/api/tasks`, { postUrl: url, dialogs: payloadDialogs })
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
      const payloadEntries = await Promise.all(list.map(async (e) => ({
        profileUuid: e.profileUuid,
        commentText: e.comment,
        image: e.image ? await varyImage(e.image) : null,
      })))
      const { data } = await axios.post(`${API_BASE}/api/tasks`, { postUrl: url, entries: payloadEntries })
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

  const startTask = async () => {
    if (mode === 3) { await startMode3(); return }
    if (mode === 2) { await startMode2(); return }
    setError('')
    const rawItems = posts
      .map((p) => ({ url: (p.url || '').trim(), image: p.image || null }))
      .filter((p) => p.url)
    if (!profileUuid) { setError('Выберите профиль'); return }
    if (rawItems.length === 0) { setError('Добавьте хотя бы одну ссылку на пост'); return }
    if (!commentText.trim()) { setError('Введите текст комментария'); return }

    setSubmitting(true)
    try {
      const items = await Promise.all(rawItems.map(async (it) => ({
        url: it.url,
        image: it.image ? await varyImage(it.image) : null,
      })))
      const { data } = await axios.post(`${API_BASE}/api/tasks`, {
        profileUuid,
        posts: items,
        commentText,
      })
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

  // Селект «тег + фейк» с фильтром по строке поиска (общий для режимов 2/3).
  const fakeSelect = (value, tag, searchStr, onTag, onFake) => (
    <>
      {allTags.length > 0 && (
        <select value={tag} onChange={onTag} title="Тег" style={{ flex: '0 0 auto', maxWidth: '140px', padding: '8px' }}>
          <option value="">Fakes | Sweeps</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
      <select value={value} onChange={onFake} style={{ flex: 1, padding: '8px' }}>
        <option value="">— выберите фейк —</option>
        {entryProfiles(tag)
          .filter((p) => !searchStr || (p.title || '').toLowerCase().includes(String(searchStr).toLowerCase()))
          .map((p) => {
            const b = profileBusy(p.uuid)
            return <option key={p.uuid} value={p.uuid}>{p.title}{b ? ` — ${b}` : ''}</option>
          })}
      </select>
    </>
  )

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
            {allTags.length > 0 && (
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} style={{ flex: '0 0 auto' }}>
                <option value="">Fakes | Sweeps</option>
                {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
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
                <button
                  key={p.uuid}
                  type="button"
                  role="option"
                  aria-selected={sel}
                  className={`tm-list-item${sel ? ' active' : ''}`}
                  onClick={() => setProfileUuid(p.uuid)}
                >
                  {p.title}{p.tags && p.tags.length ? ` [${p.tags.join(', ')}]` : ''}
                  {b ? ` — ⏳ ${b}` : ''}
                </button>
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
            <ImagePicker
              image={post.image}
              imageName={post.imageName}
              onPick={(f) => pickImage(i, f)}
              onClear={() => patchPost(i, { image: null, imageName: '' })}
            />
            {post.image && posts.length > 1 && (
              <button type="button" className="tm-btn" onClick={() => applyImageToAll(post.image, post.imageName)} title="Поставить эту картинку на все посты" style={{ flex: '0 0 auto', fontSize: '11px', padding: '4px 8px' }}>
                ко всем
              </button>
            )}
            {posts.length > 1 && (
              <button type="button" className="tm-btn tm-btn-danger" onClick={() => removePost(i)} title="Удалить строку" style={{ width: '38px', height: '44px', flex: '0 0 auto', fontSize: '18px', padding: 0 }}>×</button>
            )}
          </div>
        ))}
      </div>

      <textarea
        placeholder="Текст комментария"
        value={commentText}
        onChange={(e) => setCommentText(e.target.value)}
        style={{ height: '100px' }}
      />
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
                            {k === 0 ? 'верхний коммент (в ветку / всем)' : `реплику ${k + 1} (ответ @одному)`}
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

      <button className="tm-btn tm-btn-primary" onClick={startTask} disabled={submitting || isBusy}>
        {submitting ? 'Отправка…' : isBusy ? 'Выполняется…' : 'Запустить'}
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

  const [activeMode, setActiveMode] = useState(1)
  const [tabs, setTabs] = useState({ 1: [{ id: 1 }], 2: [{ id: 1 }], 3: [{ id: 1 }] })
  const [activeId, setActiveId] = useState({ 1: 1, 2: 1, 3: 1 })
  const nextId = useRef({ 1: 2, 2: 2, 3: 2 })

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

  const addTab = (m) => {
    if (tabs[m].length >= MAX_OPS) return
    const id = nextId.current[m]
    nextId.current[m] += 1
    setTabs((prev) => ({ ...prev, [m]: [...prev[m], { id }] }))
    setActiveId((prev) => ({ ...prev, [m]: id }))
  }

  const closeTab = (m, id) => {
    const list = tabs[m]
    const idx = list.findIndex((x) => x.id === id)
    const next = list.filter((x) => x.id !== id)
    if (!next.length) return
    setTabs((prev) => ({ ...prev, [m]: next }))
    if (activeId[m] === id) {
      const pick = (next[idx] || next[next.length - 1]).id
      setActiveId((prev) => ({ ...prev, [m]: pick }))
    }
  }

  const MODES = [
    { m: 1, label: 'Режим 1 · один фейк → много постов' },
    { m: 2, label: 'Режим 2 · один пост → много фейков' },
    { m: 3, label: 'Режим 3 · диалоги (дерево)' },
  ]

  if (!IS_EMBEDDED && !IS_LOCAL) {
    return (
      <div style={{ maxWidth: '560px', margin: '80px auto', padding: '24px', textAlign: 'center', color: 'var(--muted)' }}>
        Этот инструмент доступен только из рабочего кабинета.
      </div>
    )
  }

  if (!authReady) {
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

      {/* Под каждым режимом — свой набор операций (обе ветки смонтированы) */}
      {MODES.map(({ m }) => (
        <div key={m} style={{ display: activeMode === m ? 'block' : 'none' }}>
          <div className="tm-tabs">
            {tabs[m].map((t, idx) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                className={`tm-tab${t.id === activeId[m] ? ' active' : ''}`}
                onClick={() => setActiveId((prev) => ({ ...prev, [m]: t.id }))}
                onKeyDown={(e) => { if (e.key === 'Enter') setActiveId((prev) => ({ ...prev, [m]: t.id })) }}
              >
                Операция {idx + 1}
                {tabs[m].length > 1 && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="tm-tab-x"
                    title="Закрыть операцию"
                    onClick={(e) => { e.stopPropagation(); closeTab(m, t.id) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeTab(m, t.id) } }}
                  >
                    ×
                  </span>
                )}
              </div>
            ))}
            <button
              type="button"
              className="tm-add-tab"
              onClick={() => addTab(m)}
              disabled={tabs[m].length >= MAX_OPS}
              title={tabs[m].length >= MAX_OPS ? `Максимум ${MAX_OPS} операций` : 'Добавить операцию'}
              style={{ width: '48px', height: '36px', fontSize: '20px', marginLeft: '4px', marginBottom: '2px' }}
            >
              +
            </button>
          </div>

          {tabs[m].map((t) => (
            <div key={t.id} style={{ display: activeId[m] === t.id ? 'block' : 'none' }}>
              <Operation
                mode={m}
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
      ))}

      {/* Вкладка «История и прогресс» */}
      <div style={{ display: activeMode === 'history' ? 'block' : 'none' }}>
        <History profiles={profiles} />
      </div>
    </div>
  )
}

export default App
