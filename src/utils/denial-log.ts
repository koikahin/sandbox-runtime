import {
  appendFileSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SandboxViolationStore } from '../sandbox/sandbox-violation-store.js'

export interface DenialLog {
  path: string
  readonly count: number
  close(): void
}

/** Give macOS `log stream` time to install its predicate before a short-lived
 * command can produce a denial and exit. The monitor process is started by
 * SandboxManager.initialize(); other platforms need no startup grace. */
export async function waitForDenialLogReady(): Promise<void> {
  if (process.platform !== 'darwin') return
  await new Promise(resolve => setTimeout(resolve, 200))
}

/**
 * Stream every violation added to SRT's bounded in-memory store to JSONL.
 * The store notifies synchronously for each addition, so logging the newly
 * added tail preserves events even after the store rotates past 100 entries.
 */
export function createDenialLog(
  store: SandboxViolationStore,
  requestedPath?: string,
): DenialLog {
  const logPath = requestedPath
    ? resolve(requestedPath)
    : join(mkdtempSync(join(tmpdir(), 'srt-denials-')), 'denials.jsonl')

  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'w', 0o600)
  fchmodSync(fd, 0o600)
  let totalSeen = store.getTotalCount()
  let count = 0
  let closed = false

  const unsubscribe = store.subscribe(violations => {
    const total = store.getTotalCount()
    const added = total - totalSeen
    if (added <= 0 || closed) return

    for (const violation of violations.slice(-added)) {
      appendFileSync(
        fd,
        `${JSON.stringify({
          timestamp: violation.timestamp.toISOString(),
          command: violation.command ?? null,
          denial: violation.line,
        })}\n`,
      )
      count += 1
    }
    totalSeen = total
  })

  return {
    path: logPath,
    get count() {
      return count
    },
    close() {
      if (closed) return
      closed = true
      unsubscribe()
      closeSync(fd)
    },
  }
}

/**
 * Seatbelt denials arrive through macOS's unified log asynchronously. Give
 * the stream a short bounded drain window after the command exits. Other
 * platforms report violations synchronously and only need one event-loop turn.
 */
export async function waitForDenialLogDrain(): Promise<void> {
  const delayMs = process.platform === 'darwin' ? 750 : 25
  await new Promise(resolve => setTimeout(resolve, delayMs))
}
