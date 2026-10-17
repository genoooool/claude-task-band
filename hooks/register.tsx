import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Lang, RunRow, RunState, TaskRow, View } from '../types'

const rows = atom({ plugin: 'task-band', key: 'rows' } as const, null)
// Sessions opened from the band, with the time they were opened (only activity before that counts as seen)
const seen = atom({ plugin: 'task-band', key: 'seenAt' } as const, {} as Record<string, number>)
const error = atom({ plugin: 'task-band', key: 'error' } as const, null)
const expanded = atom({ plugin: 'task-band', key: 'expanded' } as const, 'none' as View)
const openTasks = atom({ plugin: 'task-band', key: 'openTasks' } as const, [])
const lang = atom({ plugin: 'task-band', key: 'lang' } as const, 'en' as Lang)

// All sessions share one result: one session is on duty, reads the session records and writes a small result file; the others only read that file
const TICK_MS = 5_000
const LEASE_RENEW_MS = 30_000
const LEASE_STALE_MS = 90_000
const TITLES_EVERY_MS = 10 * 60_000
const SHARED_DIR = '.claude/task-band'
// Bump when the rules change: a newer version takes over at once from an older one on duty, so stale results do not linger
const LEASE_VERSION = 8
const ORDER: Record<RunState, number> = { failed: 0, review: 1, unread: 2, running: 3, stopped: 4, done: 5, none: 6 }
const worst = (states: RunState[]) => states.reduce<RunState>((a, b) => (ORDER[b] < ORDER[a] ? b : a), 'none')
// Scheduled runs and regular sessions: only those active in the last 24 hours, with no cap on how many
const ATTENTION_WINDOW_MS = 24 * 3600_000
// Times sit one step quieter than secondary text, in both light and dark mode
const TIME_GRAY = '#6e6e6e'
// Indent in character cells: tasks one step in from the header, runs one more
const TASK_INDENT = 3
const RUN_INDENT = 6

// The desktop app's own session record: one per session, with the scheduled task id, a status summary and when you last opened it
type SessionRecord = {
  sessionId: string
  scheduledTaskId?: string
  isArchived?: boolean
  createdAt: number
  lastActivityAt: number
  lastFocusedAt?: number | null
  title?: string
  sessionTitle?: string
  previousTitles?: string[]
  lastAssistantUuid?: string
  postTurnSummaryFor?: string
  postTurnSummary?: { status_category?: string; status_detail?: string; needs_action?: string } | null
  turnWrapUp?: { description?: string } | null
  cwd?: string
  // The session this one was started from (the sidebar shows it underneath)
  parentId?: string
}
// Keep only the fields we use, cached by modification time: an unchanged file is never read again (one file is often hundreds of KB)
type Cached = { m: number; r: SessionRecord | null }

const SESSIONS_DIR = 'Library/Application Support/Claude/claude-code-sessions'
const LOOKBACK_MS = 30 * 86400_000
const RUNNING_WINDOW_MS = 15 * 60_000

export const shortTitle = (title: string) =>
  title.replace(/^【[^】]*】/, '').split(/[（(：:]/)[0]?.trim() ?? title

// The band's own words in English and Chinese; task, session and project names are yours and stay as they are
export const TEXT: Record<Lang, Record<'attention' | 'scheduled' | 'today' | 'yesterday' | 'noAttention' | 'noScheduled' | 'failed', string>> = {
  zh: {
    attention: '需要关注',
    scheduled: '定时任务',
    today: '今天',
    yesterday: '昨天',
    noAttention: '最近 24 小时没有要处理的会话',
    noScheduled: '定时任务都处理完了',
    failed: '读取失败：',
  },
  en: {
    attention: 'Needs attention',
    scheduled: 'Scheduled',
    today: 'Today',
    yesterday: 'Yesterday',
    noAttention: 'Nothing needs you in the last 24 hours',
    noScheduled: 'All scheduled runs are handled',
    failed: 'Could not read: ',
  },
}

// Times are stored as universal timestamps; show them on the viewer's own clock.
// `offsetMinutes` (minutes east of UTC) is only passed by tests; normally the computer's timezone is used.
export const when = (ms: number, now: number, language: Lang = 'en', offsetMinutes?: number) => {
  const offset = (t: number) => (offsetMinutes ?? -new Date(t).getTimezoneOffset()) * 60_000
  const t = new Date(ms + offset(ms))
  const today = new Date(now + offset(now))
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const diff = Math.round((day(today) - day(t)) / 86400_000)
  const hm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
  if (diff === 0) return `${TEXT[language].today} ${hm}`
  if (diff === 1) return `${TEXT[language].yesterday} ${hm}`
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${hm}`
}

// Six states: running, needs you, ready for review, not opened yet, stopped midway, done
export const stateOf = (rec: SessionRecord, now: number, seenAt: Record<string, number>): RunState => {
  const summary = rec.postTurnSummary ?? {}
  const hasSummary = rec.postTurnSummaryFor === rec.lastAssistantUuid && rec.postTurnSummary != null
  // No summary for the last turn yet and recent activity: treat it as running
  if (!hasSummary && now - rec.lastActivityAt < RUNNING_WINDOW_MS) return 'running'
  // Unread only if there was activity after you last looked (opened in the app, or from the band)
  const viewedAt = Math.max(rec.lastFocusedAt ?? 0, seenAt[rec.sessionId] ?? 0)
  const isUnread = viewedAt < rec.lastActivityAt
  // The app marked it as waiting for you (expired login, rate limit, a decision). Once you have looked, stop reminding
  if (summary.status_category === 'blocked') return isUnread ? 'failed' : 'done'
  // No summary, no wrap-up and no activity: it stopped midway. A wrap-up without a summary is a normal finish
  if (!hasSummary && !rec.turnWrapUp?.description) return 'stopped'
  if (!isUnread) return 'done'
  if (summary.status_category === 'review_ready' || Boolean(summary.needs_action)) return 'review'
  // Finished but you have not opened it yet (matches the sidebar's unread dot)
  return 'unread'
}

// Status icons: a mark in a 16px filled circle, strokes on whole pixels
const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>`
export const ICONS: Record<RunState, { svg: string; alt: string }> = {
  running: {
    alt: 'Running',
    svg: icon('<circle cx="8" cy="8" r="7" fill="#378ADD"/><circle cx="5" cy="8" r="1" fill="#ffffff"/><circle cx="8" cy="8" r="1" fill="#ffffff"/><circle cx="11" cy="8" r="1" fill="#ffffff"/>'),
  },
  failed: {
    alt: 'Needs you',
    svg: icon('<circle cx="8" cy="8" r="7" fill="#E24B4A"/><path d="M8 4 L8 9" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.5" r="1" fill="#ffffff"/>'),
  },
  review: {
    alt: 'Ready for review',
    svg: icon('<circle cx="8" cy="8" r="7" fill="#EF9F27"/><path d="M5 6 L11 6 M5 8 L11 8 M5 10 L9 10" stroke="#412402" stroke-width="1.3" stroke-linecap="round"/>'),
  },
  unread: {
    alt: 'Not opened yet',
    svg: icon('<circle cx="8" cy="8" r="7" fill="#7F77DD"/><circle cx="8" cy="8" r="2.5" fill="#ffffff"/>'),
  },
  stopped: {
    alt: 'Stopped midway',
    svg: icon('<circle cx="8" cy="8" r="6.25" fill="none" stroke="#8e8e8e" stroke-width="1.5" stroke-dasharray="2.6 2.3"/><path d="M5.5 8 L10.5 8" stroke="#8e8e8e" stroke-width="1.6" stroke-linecap="round"/>'),
  },
  done: {
    alt: 'Done',
    svg: icon('<circle cx="8" cy="8" r="7" fill="#8e8e8e"/><path d="M5 8 L7 10 L11 6" fill="none" stroke="#262626" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  },
  none: { alt: '', svg: icon('') },
}

// CJK characters count as two cells; truncate with an ellipsis to keep one line
export const fit = (text: string, columns: number) => {
  let used = 0
  let out = ''
  for (const ch of text) {
    const w = /[ᄀ-￿]/.test(ch) ? 2 : 1
    if (used + w > columns - 1) return `${out}…`
    used += w
    out += ch
  }
  return out
}

const slim = (d: SessionRecord & { originCwd?: string; spawnedFrom?: { sessionId?: string } }): SessionRecord | null =>
  d.isArchived
    ? null
    : {
        sessionId: d.sessionId,
        scheduledTaskId: d.scheduledTaskId,
        createdAt: d.createdAt,
        lastActivityAt: d.lastActivityAt,
        lastFocusedAt: d.lastFocusedAt ?? null,
        // Task name: the run's first title (the scheduled task's name); session name: its current title, as in the sidebar
        title: d.previousTitles?.[0] ?? d.title,
        sessionTitle: d.title,
        lastAssistantUuid: d.lastAssistantUuid,
        postTurnSummaryFor: d.postTurnSummaryFor,
        postTurnSummary: d.postTurnSummary ?? null,
        turnWrapUp: d.turnWrapUp?.description ? { description: d.turnWrapUp.description } : null,
        cwd: d.originCwd ?? d.cwd,
        parentId: d.spawnedFrom?.sessionId,
      }

export const buildRows = (
  records: SessionRecord[],
  now: number,
  seenAt: Record<string, number>,
  taskTitles: Record<string, string> = {},
): TaskRow[] => {
  const byTask = new Map<string, SessionRecord[]>()
  // The run you are looking at (the most recently opened session) is in front of you: count it as handled
  const onScreen = records.reduce<SessionRecord | undefined>((a, r) => ((r.lastFocusedAt ?? 0) > (a?.lastFocusedAt ?? 0) ? r : a), undefined)
  for (const rec of records) {
    if (rec.scheduledTaskId === undefined || now - rec.lastActivityAt > ATTENTION_WINDOW_MS) continue
    const list = byTask.get(rec.scheduledTaskId ?? '') ?? []
    list.push(rec)
    byTask.set(rec.scheduledTaskId ?? '', list)
  }
  const out: TaskRow[] = [...byTask.entries()].map(([taskId, recs]) => {
    recs.sort((a, b) => b.createdAt - a.createdAt)
    const all: RunRow[] = recs.map(rec => {
      const summary = rec.postTurnSummary ?? {}
      return {
        sessionId: rec.sessionId,
        state: rec.sessionId === onScreen?.sessionId ? 'done' : stateOf(rec, now, seenAt),
        startedAt: rec.createdAt,
        title: rec.sessionTitle ?? rec.title ?? '',
        summary: summary.needs_action || summary.status_detail || rec.turnWrapUp?.description || null,
      }
    })
    const runs = all
    // Prefer the scheduled task's own name; fall back to the run's first title
    const title = taskTitles[taskId] ?? shortTitle(recs[0]?.title ?? taskId)
    // A task's icon is the most urgent of its runs
    return { taskId, title, state: worst(runs.map(r => r.state)), runs }
  })
  return out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.title.localeCompare(b.title))
}

// Needs attention: regular sessions active in the last 24 hours that are running or need you, grouped by project; seen-and-done ones are left out
export const buildAttention = (
  records: SessionRecord[],
  now: number,
  seenAt: Record<string, number>,
  groupOf: (sessionId: string) => string | undefined = () => undefined,
): TaskRow[] => {
  const byProject = new Map<string, RunRow[]>()
  const parentOf = new Map(records.filter(r => r.parentId).map(r => [r.sessionId, r.parentId as string]))
  // Leave out the session you are looking at (the most recently opened one)
  const onScreen = records.reduce<SessionRecord | undefined>((a, r) => ((r.lastFocusedAt ?? 0) > (a?.lastFocusedAt ?? 0) ? r : a), undefined)
  for (const rec of records) {
    if (rec.scheduledTaskId !== undefined || now - rec.lastActivityAt > ATTENTION_WINDOW_MS) continue
    if (rec.sessionId === onScreen?.sessionId) continue
    let state = stateOf(rec, now, seenAt)
    // In a regular session "waiting for you" usually means waiting for your reply: yellow, not red
    if (state === 'failed') state = 'review'
    if (state === 'done' || state === 'none') continue
    // Project = the sidebar group; an ungrouped session follows the session it was started from (as the sidebar does); else the folder name
    let group: string | undefined
    for (let id: string | undefined = rec.sessionId, hops = 0; id && !group && hops < 10; hops++) {
      group = groupOf(id)
      id = group ? undefined : (parentOf.get(id) ?? (id === rec.sessionId ? rec.parentId : undefined))
    }
    const project = group ?? (rec.cwd ?? '').split('/').filter(Boolean).pop() ?? '其他'
    const summary = rec.postTurnSummary ?? {}
    const list = byProject.get(project) ?? []
    list.push({
      sessionId: rec.sessionId,
      state,
      startedAt: rec.lastActivityAt,
      title: rec.sessionTitle ?? rec.title ?? '',
      summary: summary.needs_action || summary.status_detail || null,
      parentId: rec.parentId,
    })
    byProject.set(project, list)
  }
  // A listed child whose parent is not listed (seen, open, or done): add the parent dimmed, for structure only, not as a reminder
  const byId = new Map(records.map(r => [r.sessionId, r]))
  for (const list of byProject.values()) {
    const ids = new Set(list.map(r => r.sessionId))
    for (const run of [...list]) {
      for (let pid = run.parentId, hops = 0; pid && !ids.has(pid) && hops < 5; hops++) {
        const parent = byId.get(pid)
        if (!parent) break
        list.push({
          sessionId: parent.sessionId,
          state: 'done',
          startedAt: parent.lastActivityAt,
          title: parent.sessionTitle ?? parent.title ?? '',
          summary: null,
          parentId: parent.parentId,
          isContext: true,
        })
        ids.add(pid)
        pid = parent.parentId
      }
    }
  }
  const out: TaskRow[] = [...byProject.entries()].map(([project, runs]) => {
    runs.sort((a, b) => b.startedAt - a.startedAt)
    return { taskId: `project:${project}`, title: project, state: worst(runs.filter(r => !r.isContext).map(r => r.state)), runs }
  })
  const latest = (t: TaskRow) => t.runs.find(r => !r.isContext)?.startedAt ?? 0
  return out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || latest(b) - latest(a))
}

// Children sit under the session they came from, one step further in; without a listed parent they sit at the top level
export const nest = (runs: RunRow[]): { run: RunRow; depth: number }[] => {
  const ids = new Set(runs.map(r => r.sessionId))
  const out: { run: RunRow; depth: number }[] = []
  const place = (run: RunRow, depth: number) => {
    out.push({ run, depth })
    for (const child of runs) if (child.parentId === run.sessionId && depth < 5) place(child, depth + 1)
  }
  for (const run of runs) if (!run.parentId || !ids.has(run.parentId)) place(run, 0)
  return out
}

// What to show: unhandled sessions plus their dimmed parents; once the children are handled the dimmed parent goes too
export const keepAttention = (runs: RunRow[]): RunRow[] => {
  const live = runs.filter(r => !r.isContext && r.state !== 'done' && r.state !== 'none')
  const parentOf = new Map(runs.map(r => [r.sessionId, r.parentId]))
  const needed = new Set<string>()
  for (const r of live) for (let p = r.parentId, hops = 0; p && hops < 5; hops++, p = parentOf.get(p)) needed.add(p)
  return runs.filter(r => live.includes(r) || (r.isContext && needed.has(r.sessionId)))
}

// Sidebar groups live in the app's own config file (group names, and which group each session is in)
const DESKTOP_CONFIG = 'Library/Application Support/Claude/claude_desktop_config.json'
export const readGroups = (config: unknown): ((sessionId: string) => string | undefined) => {
  const names: Record<string, string> = {}
  const assigned: Record<string, string> = {}
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk)
    if (!o || typeof o !== 'object') return
    const node = o as { groups?: unknown; assignments?: unknown }
    if (Array.isArray(node.groups))
      for (const g of node.groups as { id?: unknown; name?: unknown }[])
        if (typeof g?.id === 'string' && typeof g?.name === 'string') names[g.id] = g.name
    if (node.assignments && typeof node.assignments === 'object')
      for (const [k, v] of Object.entries(node.assignments as Record<string, unknown>)) if (typeof v === 'string') assigned[k] = v
    Object.values(o).forEach(walk)
  }
  const prefs = (config as { preferences?: { epitaxyPrefs?: Record<string, unknown> } } | null)?.preferences?.epitaxyPrefs
  walk(prefs?.['dframe-group-scopes'])
  return sessionId => {
    const id = assigned[`code:${sessionId}`]
    return id ? names[id] : undefined
  }
}

// A result file that is an array is the older scheduled-only format
const asBoard = (value: unknown): Board | null =>
  Array.isArray(value) ? { scheduled: value as TaskRow[], attention: [] } : value && typeof value === 'object' ? (value as Board) : null

// Scheduled task names are only known to the app's scheduled-tasks service (not on disk); remember the last ones read
let titlesAt = 0
async function taskTitles($: EngineInterface, now: number): Promise<Record<string, string>> {
  const stored = ((await $.store.get('taskTitles')) as Record<string, string> | undefined) ?? {}
  if (now - titlesAt < TITLES_EVERY_MS) return stored
  titlesAt = now
  try {
    const result = await $.mcp.call('scheduled-tasks', 'list_scheduled_tasks')
    const block = result.content.find(c => c.type === 'text') as { text?: string } | undefined
    if (result.isError || block?.text === undefined) return stored
    const tasks = JSON.parse(block.text) as { taskId: string; title?: string }[]
    const titles: Record<string, string> = {}
    for (const t of tasks) if (t.title) titles[t.taskId] = shortTitle(t.title)
    await $.store.set('taskTitles', titles)
    return titles
  } catch {
    return stored
  }
}

const ME = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
let lastWritten = ''
let lastSeenMtime = 0
let isTicking = false

const readJson = async <T,>($: EngineInterface, path: string): Promise<T | null> => {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return null
  }
}

// On duty: scan the session records (re-reading only changed files) and write the result only when it changed
async function lead($: EngineInterface, home: string, now: number) {
  const base = `${home}/${SESSIONS_DIR}`
  // The cache format changed (it now keeps the parent session): rebuild under a new key
  const old = ((await $.store.get('cache4')) as Record<string, Cached> | undefined) ?? {}
  const cache: Record<string, Cached> = {}
  const records: SessionRecord[] = []
  let isDirty = false
  for (const account of await $.fs.list(base)) {
    if (account.kind !== 'dir') continue
    for (const org of await $.fs.list(`${base}/${account.name}`)) {
      if (org.kind !== 'dir') continue
      const dir = `${base}/${account.name}/${org.name}`
      for (const file of await $.fs.list(dir)) {
        if (!file.name.startsWith('local_') || now - file.mtimeMs > LOOKBACK_MS) continue
        const path = `${dir}/${file.name}`
        const hit = old[path]
        let entry = hit
        if (hit === undefined || hit.m !== file.mtimeMs) {
          entry = { m: file.mtimeMs, r: slim(JSON.parse(await $.fs.read(path))) }
          isDirty = true
        }
        cache[path] = entry as Cached
        if (entry?.r) records.push(entry.r)
      }
    }
  }
  if (isDirty || Object.keys(old).length !== Object.keys(cache).length) {
    await $.store.set('cache4', cache)
    await $.store.delete('cache3')
    await $.store.delete('cache2')
  }
  const storedSeen = (await $.store.get('seenAt')) as Record<string, number> | undefined
  const seenAt = storedSeen ?? (await read($, seen))
  const next: Board = {
    scheduled: buildRows(records, now, seenAt, await taskTitles($, now)),
    attention: buildAttention(records, now, seenAt, readGroups(await readJson<unknown>($, `${home}/${DESKTOP_CONFIG}`))),
  }
  const text = JSON.stringify(next)
  if (text !== lastWritten) {
    lastWritten = text
    await $.fs.write(`${home}/${SHARED_DIR}/board.json`, text)
    await update($, rows, () => next)
  }
  await update($, error, () => null)
}

// Everyone else: read the result file only when it changed
async function follow($: EngineInterface, home: string) {
  const path = `${home}/${SHARED_DIR}/board.json`
  try {
    const { mtimeMs } = await $.fs.stat(path)
    if (mtimeMs === lastSeenMtime) return
    lastSeenMtime = mtimeMs
  } catch {
    return
  }
  const next = asBoard(await readJson<unknown>($, path))
  if (next) await update($, rows, () => next)
}

// The display language lives in a shared file: switch it in one session and every session follows
let prefsMtime = 0
async function syncPrefs($: EngineInterface, home: string) {
  const path = `${home}/${SHARED_DIR}/prefs.json`
  try {
    const { mtimeMs } = await $.fs.stat(path)
    if (mtimeMs === prefsMtime) return
    prefsMtime = mtimeMs
  } catch {
    return
  }
  const prefs = await readJson<{ lang?: Lang }>($, path)
  if (prefs?.lang === 'zh' || prefs?.lang === 'en') await update($, lang, () => prefs.lang as Lang)
}

// Set or toggle the language; it is saved to disk, so it survives an app restart
async function setLang($: EngineInterface, to: Lang | 'toggle') {
  const home = (await $.env.get('HOME')) ?? ''
  await update($, lang, v => (to === 'toggle' ? (v === 'zh' ? 'en' : 'zh') : to))
  await $.fs.write(`${home}/${SHARED_DIR}/prefs.json`, JSON.stringify({ lang: await read($, lang) }))
}

// The switch: a gray pill, knob on the left for Chinese, on the right for English
export const switchSvg = (language: Lang) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="18" viewBox="0 0 34 18">` +
  `<rect x="1" y="1" width="32" height="16" rx="8" fill="#5f5f5f"/>` +
  `<circle cx="${language === 'en' ? 25 : 9}" cy="9" r="6" fill="#ffffff"/>` +
  `</svg>`

// Every 5 seconds; if the session on duty has not checked in for 90 seconds, this one takes over
async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    const home = (await $.env.get('HOME')) ?? ''
    await syncPrefs($, home)
    const now = await $.clock.now()
    const leasePath = `${home}/${SHARED_DIR}/lease2.json`
    const lease = await readJson<{ owner: string; at: number; v?: number }>($, leasePath)
    const isMine = lease?.owner === ME
    const isOlder = (lease?.v ?? 0) < LEASE_VERSION
    if (isMine || !lease || now - lease.at > LEASE_STALE_MS || isOlder) {
      if (!isMine || now - lease.at > LEASE_RENEW_MS) {
        await $.fs.write(leasePath, JSON.stringify({ owner: ME, at: now, v: LEASE_VERSION }))
        // If two sessions take over at once, the last write wins
        if (!isMine && (await readJson<{ owner: string }>($, leasePath))?.owner !== ME) return await follow($, home)
      }
      await lead($, home, now)
    } else {
      await follow($, home)
    }
  } catch (err) {
    await update($, error, () => String(err))
  } finally {
    isTicking = false
  }
}

async function openRun($: EngineInterface, sessionId: string) {
  const at = await $.clock.now()
  // Keep the latest 300
  await update($, seen, m => Object.fromEntries(Object.entries({ ...m, [sessionId]: at }).sort((a, b) => b[1] - a[1]).slice(0, 300)))
  await $.store.set('seenAt', await read($, seen))
  // The old list meant "opened once, read forever" and hid later activity: drop it
  await $.store.delete('seen')
  const markSeen = (list: TaskRow[]) =>
    list.map(task => {
      const runs = task.runs.map(r => (r.sessionId === sessionId && (r.state === 'review' || r.state === 'unread') ? { ...r, state: 'done' as const } : r))
      return { ...task, runs, state: worst(runs.map(r => r.state)) }
    })
  await update($, rows, b => (b ? { scheduled: markSeen(b.scheduled), attention: markSeen(b.attention) } : b))
  await $.process.run(['open', `claude://claude.ai/epitaxy/${sessionId}`])
}

// One click can reach both the area and the button: within 400ms only the first counts
let lastToggleAt = 0
// Open the section you click; clicking the open one closes it
async function setBand($: EngineInterface, view: Exclude<View, 'none'>) {
  const now = await $.clock.now()
  if (now - lastToggleAt < 400) return
  lastToggleAt = now
  await update($, expanded, v => (v === view ? 'none' : view))
}

async function toggleTask($: EngineInterface, taskId: string) {
  await update($, openTasks, ids => (ids.includes(taskId) ? ids.filter(id => id !== taskId) : [...ids, taskId]))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Draw the last result first and refresh in the background, so the session never waits
    // Every new session starts collapsed
    const home = (await $.env.get('HOME')) ?? ''
    const [storedSeen, shared] = await Promise.all([$.store.get('seenAt'), readJson<unknown>($, `${home}/${SHARED_DIR}/board.json`)])
    if (storedSeen && typeof storedSeen === 'object') await update($, seen, () => storedSeen as Record<string, number>)
    const sharedBoard = asBoard(shared)
    if (sharedBoard) await update($, rows, () => sharedBoard)
    // Use the saved language right away
    await syncPrefs($, home)
    $.clock.after(0, () => {
      tick($)
    })
    $.clock.every(TICK_MS, () => {
      tick($)
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const board = await read($, rows)
    const failure = await read($, error)
    if (e.props.hasSurvey || (board === null && failure === null)) return next(e)

    if (e.surface !== 'desktop') return next(e)
    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const view = await read($, expanded)
    const open = await read($, openTasks)
    const now = await $.clock.now()
    const language = await read($, lang)
    const T = TEXT[language]
    // Scheduled works like Needs attention: only unhandled runs; a task with none left is not listed
    const scheduled = (board?.scheduled ?? [])
      .map(t => ({ ...t, runs: t.runs.filter(r => r.state !== 'done' && r.state !== 'none') }))
      .filter(t => t.runs.length > 0)
      .map(t => ({ ...t, state: worst(t.runs.map(r => r.state)) }))
    // Needs attention leaves out seen-and-done sessions, and projects with nothing left
    const attention = (board?.attention ?? [])
      .map(t => ({ ...t, runs: keepAttention(t.runs) }))
      .filter(t => t.runs.some(r => !r.isContext))
      .map(t => ({ ...t, state: worst(t.runs.filter(r => !r.isContext).map(r => r.state)) }))
    const width = Math.max(20, e.props.bodyColumns - 4)
    // Times are small and gray; the icon carries the status
    const timeText = (ms: number) => (
      <Text size="footnote" tabular color={TIME_GRAY}>
        {when(ms, now, language)}
      </Text>
    )
    const circle = (state: RunState) => <Svg source={ICONS[state].svg} alt={ICONS[state].alt || ' '} width={16} height={16} />
    // The header's icon and time come from one run: the most urgent, the newest on a tie
    const signalOf = (groups: TaskRow[]) =>
      groups
        .flatMap(t => t.runs.filter(r => !r.isContext))
        .reduce<RunRow | undefined>(
          (a, r) => (!a || ORDER[r.state] < ORDER[a.state] || (ORDER[r.state] === ORDER[a.state] && r.startedAt > a.startedAt) ? r : a),
          undefined,
        )
    const head = (which: Exclude<View, 'none'>, label: string, groups: TaskRow[]) => {
      const signal = signalOf(groups)
      return (
        <Box key={`head-${which}`} gap="sm" alignItems="center">
          {circle(signal?.state ?? 'done')}
          <Button key={`toggle-${which}`} label={label} plain dimColor={view !== 'none' && view !== which} onPress={() => setBand($, which)} />
          {signal ? timeText(signal.startedAt) : null}
        </Box>
      )
    }
    // One list row: [icon name ... time]
    const line = (key: string, indent: number, icon: unknown, name: unknown, time: unknown) => (
        <Box key={key} gap="sm" paddingLeft={indent} justifyContent="space-between" alignItems="center">
          <Box gap="sm" alignItems="center">
            {icon}
            {name}
          </Box>
          {time}
        </Box>
      )
    // Invisible filler buttons make the blank space clickable: the left half opens Needs attention, the right half Scheduled
    const filler = (key: string, which: Exclude<View, 'none'>, cells: number) => (
      <Button key={key} label={'\u00a0'.repeat(Math.max(1, Math.round(cells * 0.8)))} plain onPress={() => setBand($, which)} />
    )
    const headRow = (
      <Box key="head" gap="sm" alignItems="center" overflow="hidden">
        {/* Both sides share the width equally, so the switch stays centered whatever the text length */}
        <Box key="side-attn" gap="sm" alignItems="center" flexGrow={1} width={0} overflow="hidden">
          {head('attention', T.attention, attention)}
          {filler('fill-attn', 'attention', (width - 70) / 2)}
        </Box>
        {/* The language switch in the middle: click 中, EN or the switch itself */}
        <Box key="lang" gap="sm" alignItems="center">
          <Button key="lang-zh" label="中" plain dimColor={language !== 'zh'} onPress={() => setLang($, 'zh')} />
          <Box position="relative">
            <Svg source={switchSvg(language)} alt={language === 'en' ? 'EN' : '中'} width={34} height={18} />
            <Box position="absolute" top={0} left={0}>
              <Button key="lang-switch" label={'\u00a0'.repeat(5)} plain onPress={() => setLang($, 'toggle')} />
            </Box>
          </Box>
          <Button key="lang-en" label="EN" plain dimColor={language !== 'en'} onPress={() => setLang($, 'en')} />
        </Box>
        <Box key="side-sched" gap="sm" alignItems="center" justifyContent="flex-end" flexGrow={1} width={0} overflow="hidden" paddingRight="lg">
          {filler('fill-sched', 'scheduled', (width - 70) / 2)}
          {head('scheduled', T.scheduled, scheduled)}
        </Box>
      </Box>
    )
    if (view === 'none') return headRow

    // Expanded: tasks or projects, each opening to its runs or sessions; both sections look the same
    const groups = view === 'scheduled' ? scheduled : attention
    const rowsList: unknown[] = []
    if (failure !== null) rowsList.push(<Text key="err" size="footnote" color="error" wrap="truncate">{T.failed}{failure}</Text>)
    if (groups.length === 0)
      rowsList.push(
        <Box key="empty" paddingLeft={TASK_INDENT}>
          <Text size="footnote" color={TIME_GRAY}>{view === 'attention' ? T.noAttention : T.noScheduled}</Text>
        </Box>,
      )
    for (const task of groups) {
      const latest = task.runs[0]
      rowsList.push(
        line(
          task.taskId,
          TASK_INDENT,
          circle(task.state),
          <Button key={`task-${task.taskId}`} label={fit(task.title, width - 14)} plain onPress={() => toggleTask($, task.taskId)} />,
          latest ? timeText(latest.startedAt) : null,
        ),
      )
      if (!open.includes(task.taskId)) continue
      for (const { run, depth } of nest(task.runs))
        rowsList.push(
          line(
            run.sessionId,
            RUN_INDENT + depth * (RUN_INDENT - TASK_INDENT),
            circle(run.state),
            <Button
              key={`run-${run.sessionId}`}
              label={fit(run.title || task.title, width - 18 - depth * 3)}
              plain
              dimColor={run.isContext || run.state === 'done' || run.state === 'none'}
              onPress={() => openRun($, run.sessionId)}
            />,
            timeText(run.startedAt),
          ),
        )
    }
    return (
      <Box flexDirection="column" rowGap="xs">
        {headRow}
        {rowsList}
      </Box>
    )
  })
}
