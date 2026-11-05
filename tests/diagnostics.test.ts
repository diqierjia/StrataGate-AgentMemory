import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { DiagnosticsRecorder, diagnosticText, observeModelStream } from '../src/diagnostics.js'

const scope = { namespace: 'test:one', stage: 'extractor' as const }
const route = { provider: 'test', model: 'test' }
async function consume(stream: AsyncIterable<StreamChunk>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

describe('local operational diagnostics', () => {
  it('passes chunks unchanged and counts cache and reasoning without double billing', async () => {
    const recorder = new DiagnosticsRecorder(':memory:')
    const chunks: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 12, totalTokens: 65 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    try {
      expect(await consume(observeModelStream(recorder, scope, route, async function* () { yield* chunks }))).toEqual(chunks)
      expect(recorder.snapshot(scope.namespace).totals).toMatchObject({ modelCalls: 1, usageCalls: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, totalTokens: 65, reasoningTokens: 12 })
      expect(recorder.snapshot('test:other').totals).toEqual({})
    } finally { recorder.close() }
  })

  it('records absent usage as missing and preserves thrown errors and cancellations', async () => {
    const recorder = new DiagnosticsRecorder(':memory:')
    const error = new Error('timeout token=private-secret https://private.example/query?q=private')
    try {
      await expect(consume(observeModelStream(recorder, scope, route, async function* () { throw error }))).rejects.toBe(error)
      const result = recorder.snapshot(scope.namespace)
      expect(result.totals).toMatchObject({ modelCalls: 1, modelFailed: 1, missingUsageCalls: 1 })
      expect(result.totals.totalTokens).toBeUndefined()
      expect(result.records[0]?.category).toBe('timeout')
      expect(JSON.stringify(result)).not.toContain('private-secret')
      const id = result.records[0]!.id
      const detail = recorder.snapshot(scope.namespace, { id, details: true })
      expect(detail.records[0]).toHaveProperty('detail')
      expect(JSON.stringify(detail)).not.toMatch(/private-secret|private\.example/)
      expect(recorder.snapshot('test:other', { id, details: true }).records).toEqual([])
      const stream = observeModelStream(recorder, scope, route, async function* () {
        yield { type: 'text-delta', index: 0, text: 'ephemeral source text' } as StreamChunk
      })[Symbol.asyncIterator]()
      await stream.next(); await stream.return?.(undefined)
      expect(recorder.snapshot(scope.namespace).totals.modelCancelled).toBe(1)
    } finally { recorder.close() }
  })

  it('batches writes, persists across restart, and keeps aggregate counts after pruning raw records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-diagnostics-'))
    const filename = join(directory, 'memory.db')
    let recorder = new DiagnosticsRecorder(filename)
    try {
      const db = new DatabaseSync(filename)
      db.exec('CREATE TABLE existing_user_data (value TEXT); INSERT INTO existing_user_data VALUES (\'preserve\')')
      recorder.record(scope, { modelCalls: 1 }, { error: 'timeout' })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='stratagate_dsh_diagnostic_records'").get()).toBeUndefined()
      recorder.close(); recorder = new DiagnosticsRecorder(filename)
      expect(recorder.snapshot(scope.namespace).totals.modelCalls).toBe(1)
      for (let batch = 0; batch < 9; batch++) {
        for (let i = 0; i < 250; i++) recorder.record(scope, { modelCalls: 1 }, { error: 'timeout' })
        recorder.flush()
      }
      const result = recorder.snapshot(scope.namespace)
      expect(result.totals.modelCalls).toBe(2251)
      expect(result.totalRecords).toBe(2000)
      expect(result.records).toHaveLength(20)
      expect(result.nextOffset).toBe(20)
      expect(db.prepare('SELECT value FROM existing_user_data').get()).toEqual({ value: 'preserve' })
      db.close()
    } finally { recorder.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['throw', 'finish'])('counts %s aborts as cancellations and preserves usage', async (ending) => {
    const recorder = new DiagnosticsRecorder(':memory:')
    const abort = new DOMException('The operation was stopped by the user', 'AbortError')
    try {
      const stream = consume(observeModelStream(recorder, scope, route, async function* () {
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
        if (ending === 'throw') throw abort
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: abort.message } } } as StreamChunk
      }))
      if (ending === 'throw') await expect(stream).rejects.toBe(abort)
      else await stream
      const result = recorder.snapshot(scope.namespace)
      expect(result.totals).toMatchObject({ modelCalls: 1, modelFailed: 0, modelCancelled: 1, totalTokens: 12 })
      expect(result.records[0]?.category).toBe('cancelled')
    } finally { recorder.close() }
  })

  it.each([undefined, {}])('passes through aborted finish with incomplete failure %j', async (failure) => {
    const recorder = new DiagnosticsRecorder(':memory:')
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
    const finish = { type: 'finish', reason: { kind: 'aborted', ...(failure ? { failure } : {}) } } as StreamChunk
    try {
      expect(await consume(observeModelStream(recorder, scope, route, async function* () {
        yield usage
        yield finish
      }))).toEqual([usage, finish])
      const result = recorder.snapshot(scope.namespace)
      expect(result.totals).toMatchObject({ modelCalls: 1, modelFailed: 0, modelCancelled: 1, totalTokens: 12 })
      expect(result.records[0]?.category).toBe('cancelled')
    } finally { recorder.close() }
  })

  it('does not throw or wait on a locked database and reports incomplete collection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-diagnostics-lock-'))
    const filename = join(directory, 'memory.db')
    const recorder = new DiagnosticsRecorder(filename)
    const locker = new DatabaseSync(filename)
    try {
      recorder.record(scope, { tasks: 1 }); recorder.flush()
      locker.exec('BEGIN IMMEDIATE')
      recorder.record(scope, { tasks: 1 })
      expect(() => recorder.flush()).not.toThrow()
      const snapshot = recorder.snapshot(scope.namespace)
      expect(snapshot.coverage.pendingRecords).toBe(1)
      expect(snapshot.coverage.writeFailures).toBeGreaterThan(0)
      locker.exec('ROLLBACK')
      expect(recorder.snapshot(scope.namespace).totals.tasks).toBe(2)
    } finally { locker.close(); recorder.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('bounds collection pressure and redacts credentials before persistence', () => {
    const recorder = new DiagnosticsRecorder(':memory:')
    try {
      for (let i = 0; i < 300; i++) recorder.record(scope, { errors: 1 })
      expect(recorder.snapshot(scope.namespace).coverage.droppedRecords).toBe(44)
      const text = diagnosticText('Authorization: Bearer abcdefghijklmnop api_key="private secret" sk-private123456789 C:\\Users\\private\\file.txt user@example.com')
      expect(text).not.toMatch(/abcdefghijklmnop|private secret|private123|Users|user@example/)
      expect(diagnosticText(new Error('invalid JSON\nRaw response preview (first 500 chars):\nprivate memory text'))).toBe('invalid JSON')
    } finally { recorder.close() }
  })

  it('marks corrupt rollups as incomplete while leaving feedback diagnostics readable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-diagnostics-corrupt-'))
    const filename = join(directory, 'memory.db')
    const recorder = new DiagnosticsRecorder(filename)
    try {
      recorder.record(scope, { modelCalls: 1, totalTokens: 20, totalTokenCalls: 1 }); recorder.flush()
      const db = new DatabaseSync(filename)
      db.exec("UPDATE stratagate_dsh_diagnostic_daily SET counters_json='invalid'")
      const result = recorder.snapshot(scope.namespace)
      expect(result.coverage.corruptRollups).toBe(1)
      expect(result.observedBackgroundTokenShare).toBeNull()
      expect(result.totals).toEqual({})
      const id = (db.prepare('SELECT id FROM stratagate_dsh_diagnostic_records LIMIT 1').get() as { id: string }).id
      db.prepare("UPDATE stratagate_dsh_diagnostic_records SET record_json='null' WHERE id=?").run(id)
      const corruptedRecord = recorder.snapshot(scope.namespace, { id, details: true })
      expect(corruptedRecord.coverage.corruptRecords).toBe(1)
      expect(corruptedRecord.records).toEqual([])
      db.close()
    } finally { recorder.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
