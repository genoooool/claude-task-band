import { expect, mock, test } from 'claude-code/testing'

import { fit, readGroups, shortTitle, stateOf, switchSvg, when } from '../hooks/register'

const NOW = Date.parse('2026-10-18T02:00:00Z')
const HOUR = 3600_000
const BASE = '/home/Library/Application Support/Claude/claude-code-sessions'
const DIR = `${BASE}/acct/org`
const SHARED = '/home/.claude/task-band'

// A scheduled run's session record, as the desktop app writes it
const record = (sessionId: string, taskId: string, fields: Record<string, unknown>) => ({
  sessionId,
  scheduledTaskId: taskId,
  createdAt: NOW - HOUR,
  lastActivityAt: NOW - 50 * 60_000,
  lastAssistantUuid: 'a',
  postTurnSummaryFor: 'a',
  postTurnSummary: { status_category: 'completed', status_detail: 'Done', needs_action: '' },
  ...fields,
})
// A regular (non-scheduled) session's record
const regular = (sessionId: string, cwd: string, fields: Record<string, unknown>) => {
  const r = record(sessionId, '', { cwd, title: `Session ${sessionId}`, ...fields }) as Record<string, unknown>
  delete r.scheduledTaskId
  return r
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// The description of the first icon under an element (icons have no text of their own)
const iconIn = (el: unknown): string | undefined => {
  const node = el as { type?: string; props?: { alt?: string }; children?: unknown[] } | undefined
  if (!node) return undefined
  if (node.type === 'Svg') return node.props?.alt
  for (const child of node.children ?? []) {
    const found = iconIn(child)
    if (found) return found
  }
  return undefined
}
const textOf = (el: { text?: string } | undefined) => (el?.text ?? '').replace(/ /g, '')

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: NOW - 1000, isLink: false })

// A fake disk: session records under DIR, plus the shared files the plugin writes itself
const mockDisk = (on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, unknown>) => {
  const written: Record<string, { text: string; mtimeMs: number }> = {}
  let tick = 0
  const calls = { list: 0 }
  on('fs.list', ($, e) => (calls.list++, {
    value:
      e.path === BASE ? [entry('acct', 'dir')]
      : e.path === `${BASE}/acct` ? [entry('org', 'dir')]
      : Object.keys(files).map(name => entry(name, 'file')),
  }))
  on('fs.read', ($, e) => {
    if (written[e.path]) return { value: written[e.path]!.text }
    const file = files[e.path.slice(DIR.length + 1)]
    return file === undefined ? { deny: 'ENOENT' } : { value: JSON.stringify(file) }
  })
  on('fs.write', ($, e) => {
    written[e.path] = { text: e.text, mtimeMs: ++tick }
    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    written[e.path] ? { value: { kind: 'file', size: 0, mtimeMs: written[e.path]!.mtimeMs, isLink: false } } : { deny: 'ENOENT' },
  )
  const put = (path: string, value: unknown) => (written[path] = { text: JSON.stringify(value), mtimeMs: ++tick })
  return { written, calls, put }
}

const start = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, unknown>) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home' })
  on('session.start', () => ({ cwd: '/' }))
  const disk = mockDisk(on, files)
  const opened: string[][] = []
  on('process.run', ($, e) => {
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, disk, opened }
}

test('titles, times and widths', () => {
  expect(shortTitle('【Daily 14:00】Podcast notes：read stats')).toBe('Podcast notes')
  expect(shortTitle('Morning digest (8/12/19)')).toBe('Morning digest')
  // Shown on the viewer's clock; here pinned to UTC+8
  expect(when(Date.parse('2026-10-18T01:02:00Z'), NOW, 'en', 480)).toBe('Today 09:02')
  expect(when(Date.parse('2026-10-17T05:01:00Z'), NOW, 'en', 480)).toBe('Yesterday 13:01')
  expect(when(Date.parse('2026-10-17T05:01:00Z'), NOW, 'zh', 480)).toBe('昨天 13:01')
  expect(when(Date.parse('2026-10-15T05:01:00Z'), NOW, 'en', 480)).toBe('10/15 13:01')
  // The same moment in UTC-7
  expect(when(Date.parse('2026-10-18T01:02:00Z'), NOW, 'en', -420)).toBe('Today 18:02')
  expect(fit('读数据读数据', 9)).toBe('读数据读…')
  expect(fit('short', 20)).toBe('short')
  // The switch is always gray; the knob is left for Chinese, right for English
  expect(switchSvg('zh')).toContain('cx="9"')
  expect(switchSvg('en')).toContain('cx="25"')
  expect(switchSvg('en')).toContain('#5f5f5f')
})

test('each run gets one of the six states', () => {
  const at = (fields: Record<string, unknown>) => stateOf(record('s', 'daily-video', fields) as never, NOW, {})
  expect(at({ postTurnSummaryFor: 'old', lastActivityAt: NOW - 60_000 })).toBe('running')
  expect(at({ postTurnSummary: { status_category: 'blocked', needs_action: 'rate limited' } })).toBe('failed')
  expect(at({ postTurnSummary: { status_category: 'blocked', needs_action: 'rate limited' }, lastFocusedAt: NOW })).toBe('done')
  expect(at({ postTurnSummary: { status_category: 'review_ready' } })).toBe('review')
  expect(at({ postTurnSummaryFor: 'old' })).toBe('stopped')
  // A wrap-up without a summary is a normal finish
  expect(at({ postTurnSummaryFor: 'old', turnWrapUp: { description: 'Done' }, lastFocusedAt: NOW })).toBe('done')
  expect(at({ lastFocusedAt: NOW })).toBe('done')
  expect(at({})).toBe('unread')
  expect(at({ postTurnSummary: { status_category: 'review_ready' }, lastFocusedAt: NOW })).toBe('done')
  // Opened from the band counts as seen, until there is newer activity
  expect(stateOf(record('s', 'x', {}) as never, NOW, { s: NOW })).toBe('done')
  expect(stateOf(record('s', 'x', { lastActivityAt: NOW + 5000 }) as never, NOW, { s: NOW })).toBe('unread')
})

test('scheduled: only unhandled runs show, and opening one clears it', async ($, on) => {
  const files = {
    'local_review.json': record('local_review', 'reply-drafts', { previousTitles: ['Reply drafts'] }),
    'local_old.json': record('local_old', 'reply-drafts', { createdAt: NOW - 20 * HOUR, lastActivityAt: NOW - 20 * HOUR, title: 'Reply drafts | earlier run', previousTitles: ['Reply drafts'] }),
    'local_seen.json': record('local_seen', 'daily-video', { lastFocusedAt: NOW - 60_000, previousTitles: ['Daily video'] }),
    'local_blocked.json': record('local_blocked', 'newsletter', { previousTitles: ['Newsletter'], postTurnSummary: { status_category: 'blocked', status_detail: '', needs_action: 'log in again' } }),
    'local_running.json': record('local_running', 'digest', { createdAt: NOW - 30 * 60_000, lastActivityAt: NOW - 60_000, postTurnSummaryFor: 'old', previousTitles: ['Morning digest'] }),
  }
  const { clock, opened } = await start($, on, files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const ui = await $.ui.mount({ plugin: 'task-band', surface: 'desktop', ...BAND })
  const head = async () => textOf(await ui.find({ type: 'Box', key: 'head-scheduled' }))
  // Collapsed: the header shows the most urgent run (needs you) and its time; English by default
  expect(await ui.find({ key: 'task-reply-drafts' })).toBeUndefined()
  expect(await head()).toBe(`Scheduled${when(NOW - HOUR, NOW)}`)
  expect(iconIn(await ui.find({ type: 'Box', key: 'head-scheduled' }))).toBe('Needs you')
  // Both sides share the width, so the language switch stays centered
  for (const side of ['side-attn', 'side-sched']) expect((await ui.find({ type: 'Box', key: side }))?.props.flexGrow).toBe(1)

  // The blank space opens the section too
  await ui.press({ key: 'fill-sched' })
  expect((await ui.find({ key: 'task-reply-drafts' }))?.text).toBe('Reply drafts')
  expect(iconIn(await ui.find({ type: 'Box', key: 'newsletter' }))).toBe('Needs you')
  expect(iconIn(await ui.find({ type: 'Box', key: 'digest' }))).toBe('Running')
  expect(iconIn(await ui.find({ type: 'Box', key: 'reply-drafts' }))).toBe('Not opened yet')
  // A task whose runs are all handled is not listed
  expect(await ui.find({ type: 'Box', key: 'daily-video' })).toBeUndefined()

  // Open the task to see its runs, indented one step further
  await ui.press({ key: 'task-reply-drafts' })
  expect((await ui.find({ key: 'run-local_old' }))?.text).toBe('Reply drafts | earlier run')
  expect((await ui.find({ type: 'Box', key: 'reply-drafts' }))?.props.paddingLeft).toBe(3)
  expect((await ui.find({ type: 'Box', key: 'local_old' }))?.props.paddingLeft).toBe(6)

  // Opening a run opens its session; once both runs are opened the task goes away
  await ui.press({ key: 'run-local_review' })
  expect(opened).toEqual([['open', 'claude://claude.ai/epitaxy/local_review']])
  expect(iconIn(await ui.find({ type: 'Box', key: 'reply-drafts' }))).toBe('Not opened yet')
  await ui.press({ key: 'run-local_old' })
  expect(await ui.find({ type: 'Box', key: 'reply-drafts' })).toBeUndefined()

  // The switch changes the band's words; task names stay as they are
  await ui.press({ key: 'lang-switch' })
  expect(await head()).toBe(`定时任务${when(NOW - HOUR, NOW, 'zh')}`)
  expect((await ui.find({ key: 'task-digest' }))?.text).toBe('Morning digest')
  await ui.press({ key: 'lang-en' })
  expect(await head()).toStartWith('Scheduled')

  // Clicking the header row again closes it; the same click does not reopen it
  await clock.advance(1000)
  await ui.press({ key: 'fill-sched' })
  expect(await ui.find({ key: 'task-digest' })).toBeUndefined()
  await ui.press({ key: 'toggle-scheduled' })
  expect(await ui.find({ key: 'task-digest' })).toBeUndefined()
  await ui.unmount()
})

test('scheduled: every unhandled run of the last 24 hours, named after the task', async ($, on) => {
  const files: Record<string, unknown> = {}
  // Runs six hours apart: r0 and r3 seen; r1 and r2 not opened; r5 not opened but 30 hours old
  for (const [i, seen] of [[0, true], [1, false], [2, false], [3, true], [5, false]] as const)
    files[`local_r${i}.json`] = record(`local_r${i}`, 'daily-video', {
      createdAt: NOW - i * 6 * HOUR - 60_000,
      lastActivityAt: NOW - i * 6 * HOUR,
      lastFocusedAt: seen ? NOW - i * 6 * HOUR + 1000 : null,
      title: `Daily video | run ${i}`,
      previousTitles: ['Old name (9:00)'],
    })
  const { clock } = await start($, on, files)
  on('mcp.call', () => ({
    value: { content: [{ type: 'text', text: JSON.stringify([{ taskId: 'daily-video', title: 'Daily video (9:00 review then edit)' }]) }], isError: false },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const ui = await $.ui.mount({ plugin: 'task-band', surface: 'desktop', ...BAND })
  await ui.press({ key: 'toggle-scheduled' })
  // The scheduled task's current name, not the old run title
  expect((await ui.find({ key: 'task-daily-video' }))?.text).toBe('Daily video')
  await ui.press({ key: 'task-daily-video' })
  expect(await ui.find({ key: 'run-local_r1' })).toBeDefined()
  expect(await ui.find({ key: 'run-local_r2' })).toBeDefined()
  expect(await ui.find({ key: 'run-local_r0' })).toBeUndefined()
  expect(await ui.find({ key: 'run-local_r5' })).toBeUndefined()
  await ui.unmount()
})

test('needs attention: recent regular sessions by project, children under their parent', async ($, on) => {
  const files = {
    // Video project: one waiting for your reply, one finished but not opened
    'local_ask.json': regular('local_ask', '/Users/x/video', { postTurnSummary: { status_category: 'blocked', needs_action: 'Approve the cover?' } }),
    'local_new.json': regular('local_new', '/Users/x/video', {}),
    // A child started from local_ask in another folder follows its parent's group
    'local_child.json': regular('local_child', '/Users/x/blog', { spawnedFrom: { sessionId: 'local_ask' } }),
    // A seen parent with an unread child: the parent shows dimmed above it
    'local_parent.json': regular('local_parent', '/Users/x/video', { lastFocusedAt: NOW }),
    'local_kid2.json': regular('local_kid2', '/Users/x/blog', { spawnedFrom: { sessionId: 'local_parent' } }),
    // Seen and done: not listed, and neither is its project
    'local_seen.json': regular('local_seen', '/Users/x/shop', { lastFocusedAt: NOW }),
    // Not opened but two days old: outside the 24 hours
    'local_old.json': regular('local_old', '/Users/x/notes', { createdAt: NOW - 72 * HOUR, lastActivityAt: NOW - 48 * HOUR }),
    // The session on screen (most recently opened) is left out even with newer activity
    'local_here.json': regular('local_here', '/Users/x/Downloads', { lastFocusedAt: NOW + 1000, lastActivityAt: NOW + 2000 }),
    // Running sessions are listed
    'local_run.json': regular('local_run', '/Users/x/research', { lastActivityAt: NOW - 60_000, postTurnSummaryFor: 'old' }),
  }
  const { clock, disk } = await start($, on, files)
  disk.put('/home/Library/Application Support/Claude/claude_desktop_config.json', {
    preferences: { epitaxyPrefs: { 'dframe-group-scopes': { a: { o: { groups: [{ id: 'cg-v', name: 'Video channel' }], assignments: { 'code:local_parent': 'cg-v', 'code:local_ask': 'cg-v', 'code:local_new': 'cg-v' } } } } } },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const ui = await $.ui.mount({ plugin: 'task-band', surface: 'desktop', ...BAND })
  // One row: Needs attention on the left, Scheduled on the right
  expect(textOf(await ui.find({ type: 'Box', key: 'head' }))).toStartWith('Needs attention')
  expect(iconIn(await ui.find({ type: 'Box', key: 'head-attention' }))).toBe('Ready for review')

  await ui.press({ key: 'fill-attn' })
  expect((await ui.find({ key: 'task-project:Video channel' }))?.text).toBe('Video channel')
  expect(await ui.find({ key: 'task-project:shop' })).toBeUndefined()
  expect(await ui.find({ key: 'task-project:notes' })).toBeUndefined()
  expect(await ui.find({ key: 'task-project:Downloads' })).toBeUndefined()
  expect(await ui.find({ key: 'task-project:blog' })).toBeUndefined()
  expect(iconIn(await ui.find({ type: 'Box', key: 'project:research' }))).toBe('Running')

  await ui.press({ key: 'task-project:Video channel' })
  // Waiting for your reply shows yellow, not red
  expect(iconIn(await ui.find({ type: 'Box', key: 'local_ask' }))).toBe('Ready for review')
  expect(iconIn(await ui.find({ type: 'Box', key: 'local_new' }))).toBe('Not opened yet')
  expect((await ui.find({ type: 'Box', key: 'local_child' }))?.props.paddingLeft).toBe(9)
  // The seen parent shows dimmed; its child sits under it
  expect((await ui.find({ key: 'run-local_parent' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Box', key: 'local_kid2' }))?.props.paddingLeft).toBe(9)
  // Opening the child clears it, and the dimmed parent goes with it
  await ui.press({ key: 'run-local_kid2' })
  expect(await ui.find({ key: 'run-local_parent' })).toBeUndefined()
  await ui.press({ key: 'run-local_new' })
  expect(await ui.find({ key: 'run-local_new' })).toBeUndefined()
  await ui.unmount()
})

test('project names come from the sidebar groups', () => {
  const config = {
    preferences: { epitaxyPrefs: { 'dframe-group-scopes': { acct: { org: { groups: [{ id: 'cg-1', name: 'Newsletter' }], assignments: { 'code:local_a': 'cg-1' } } } } } },
  }
  const groupOf = readGroups(config)
  expect(groupOf('local_a')).toBe('Newsletter')
  expect(groupOf('local_b')).toBeUndefined()
  expect(readGroups(null)('local_a')).toBeUndefined()
})

test('only one session reads the records; the others read its result and take over when it goes quiet', async ($, on) => {
  const { clock, disk } = await start($, on, { 'local_a.json': record('local_a', 'daily-video', { lastFocusedAt: NOW }) })
  disk.put(`${SHARED}/lease2.json`, { owner: 'other', at: NOW, v: 99 })
  disk.put(`${SHARED}/board.json`, {
    scheduled: [{ taskId: 'from-leader', title: 'Written by the leader', state: 'unread', runs: [{ sessionId: 'x', state: 'unread', startedAt: NOW, title: 'x', summary: null }] }],
    attention: [],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const ui = await $.ui.mount({ plugin: 'task-band', surface: 'desktop', ...BAND })
  await ui.press({ key: 'toggle-scheduled' })
  expect(disk.calls.list).toBe(0)
  expect((await ui.find({ key: 'task-from-leader' }))?.text).toBe('Written by the leader')

  // The leader has not checked in for 90 seconds: this session takes over
  await clock.advance(95_000)
  expect(disk.calls.list).toBeGreaterThan(0)
  expect(JSON.parse(disk.written[`${SHARED}/lease2.json`]!.text).owner).not.toBe('other')
  expect(disk.written[`${SHARED}/board.json`]!.text).toContain('daily-video')
  await ui.unmount()
})

test('a newer version takes over at once from an older one on duty', async ($, on) => {
  const { clock, disk } = await start($, on, { 'local_a.json': record('local_a', 'daily-video', { lastFocusedAt: NOW }) })
  disk.put(`${SHARED}/lease2.json`, { owner: 'old', at: NOW })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)
  expect(JSON.parse(disk.written[`${SHARED}/lease2.json`]!.text).owner).not.toBe('old')
  expect(disk.calls.list).toBeGreaterThan(0)
})

test('the chosen language is remembered', async ($, on) => {
  const { clock, disk } = await start($, on, { 'local_a.json': record('local_a', 'daily-video', {}) })
  disk.put(`${SHARED}/prefs.json`, { lang: 'zh' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'task-band', surface: 'desktop', ...BAND })
  expect(textOf(await ui.find({ type: 'Box', key: 'head-scheduled' }))).toStartWith('定时任务')
  await ui.unmount()
})
