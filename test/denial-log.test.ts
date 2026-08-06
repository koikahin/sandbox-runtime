import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxViolationStore } from '../src/sandbox/sandbox-violation-store.js'
import { createDenialLog } from '../src/utils/denial-log.js'

describe('denial log', () => {
  it('writes every violation exactly once as JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srt-denial-log-test-'))
    const output = join(dir, 'nested', 'denials.jsonl')
    const store = new SandboxViolationStore()
    const log = createDenialLog(store, output)

    try {
      store.addViolation({
        line: 'deny file-read-data /private/secret',
        command: 'cat /private/secret',
        timestamp: new Date('2026-01-02T03:04:05.000Z'),
      })
      store.addViolation({
        line: 'deny file-write-create /private/output',
        command: 'touch /private/output',
        timestamp: new Date('2026-01-02T03:04:06.000Z'),
      })
      log.close()

      const records = readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(log.count).toBe(2)
      expect(statSync(output).mode & 0o777).toBe(0o600)
      expect(records).toEqual([
        {
          timestamp: '2026-01-02T03:04:05.000Z',
          command: 'cat /private/secret',
          denial: 'deny file-read-data /private/secret',
        },
        {
          timestamp: '2026-01-02T03:04:06.000Z',
          command: 'touch /private/output',
          denial: 'deny file-write-create /private/output',
        },
      ])

      // close() is idempotent and unsubscribes from future events.
      log.close()
      store.addViolation({
        line: 'deny file-read-data /ignored-after-close',
        timestamp: new Date(),
      })
      expect(readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(2)
    } finally {
      log.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a private temporary log when no path is supplied', () => {
    const store = new SandboxViolationStore()
    const log = createDenialLog(store)
    try {
      expect(log.path).toContain('srt-denials-')
      expect(log.path).toEndWith('denials.jsonl')
    } finally {
      const dir = join(log.path, '..')
      log.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
