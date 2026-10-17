export type RunState = 'running' | 'failed' | 'review' | 'unread' | 'stopped' | 'done' | 'none'

export type RunRow = {
  sessionId: string
  state: RunState
  startedAt: number
  title: string
  summary: string | null
  // Regular sessions: the session this one was started from
  parentId?: string
  // A parent added only to show structure (dimmed, not a reminder)
  isContext?: boolean
}

export type TaskRow = {
  taskId: string
  title: string
  state: RunState
  runs: RunRow[]
}

// The band's two sections: Scheduled on the right, Needs attention (regular sessions by project) on the left
export type Board = { scheduled: TaskRow[]; attention: TaskRow[] }

export type View = 'none' | 'attention' | 'scheduled'

export type Lang = 'zh' | 'en'

declare module 'claude-code' {
  interface PluginState {
    'task-band': {
      rows: Board | null
      seenAt: Record<string, number>
      error: string | null
      expanded: View
      openTasks: string[]
      lang: Lang
    }
  }
}
