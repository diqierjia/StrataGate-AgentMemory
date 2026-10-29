import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildMemoryDerivationMessages, deterministicBlockLayers, type RawMessage } from '@diqier/stratagate'
import { DailyNotes, dailyDate, DAILY_NOTE_LABEL } from '../src/daily-notes.js'
import { resolveConfig } from '../src/config.js'
import * as plugin from '../src/index.js'
import { TurnFolder } from '../src/fold.js'

const roots: string[] = []
async function fixture(budget = 12_000) {
  const root = await mkdtemp(join(tmpdir(), 'stratagate-daily-')); roots.push(root)
  return { root, notes: new DailyNotes(join(root, 'memory.db'), 'Asia/Shanghai', budget) }
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('daily Markdown storage', () => {
  it('creates safe namespace paths, serializes writers and keeps exactly the previous backup', async () => {
    const { root, notes } = await fixture()
    const ns = '../../CON/中文'; const date = '2026-10-28'
    await Promise.all(['A', 'B', 'C'].map(title => notes.write(ns, { date, title, content: `当前：${title}` })))
    const path = join(notes.directory(ns), `${date}.md`)
    expect(path.startsWith(join(root, 'daily'))).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('# 2026-10-28\n\n## A\n当前：A\n\n## B\n当前：B\n\n## C\n当前：C\n')
    expect(await readFile(`${path}.bak`, 'utf8')).not.toContain('## C')
    expect(await readdir(notes.directory(ns))).toEqual(expect.arrayContaining([`${date}.md`, `${date}.md.bak`]))
    expect((await readdir(notes.directory(ns))).length).toBe(2)
    expect((await notes.read('other')).dates).toEqual([])
  })
  it('rejects duplicates with current item text; unique replacement and deletion retain a backup', async () => {
    const { notes } = await fixture(); const args = { date: '2026-10-28', title: '修复', content: '当前：等待\n原因：失败' }
    await notes.write('n', args)
    await expect(notes.write('n', args)).rejects.toThrow('没有重复新增。该事项当前全文如下，请用 old_text 修改：\n## 修复\n当前：等待\n原因：失败')
    expect(await notes.write('n', { ...args, old_text: '当前：等待', content: '已完成：通过' })).toMatchObject({ operation: '修改', filename: '2026-10-28.md' })
    await notes.write('n', { ...args, old_text: '\n原因：失败', content: '' })
    expect((await notes.read('n', { date: args.date })).content).toBe('# 2026-10-28\n\n## 修复\n已完成：通过\n')
  })
  it('throws on missing or ambiguous matches, includes current text, falls back to whole file', async () => {
    const { notes } = await fixture(); const args = { date: '2026-10-28', title: 'A', content: '重复 重复' }
    await notes.write('n', args)
    await expect(notes.write('n', { ...args, old_text: '过期' })).rejects.toThrow('没有匹配，笔记可能已被更新。事项《A》当前全文如下，请基于它合并后重试：\n## A\n重复 重复')
    await expect(notes.write('n', { ...args, old_text: '重复' })).rejects.toThrow('匹配到 2 处')
    await expect(notes.write('n', { ...args, title: 'missing', old_text: '不存在' })).rejects.toThrow('未找到事项《missing》，以下为 2026-10-28.md 全文：\n# 2026-10-28')
    await expect(notes.write('n', { ...args, old_text: '' })).rejects.toThrow('非空原文')
  })
  it('uses configured timezone at write time and validates date/timezone/budget', async () => {
    const { notes } = await fixture()
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T16:30:00Z'))
    expect(dailyDate(new Date(), 'Asia/Shanghai')).toBe('2026-10-28')
    expect(dailyDate(new Date(), 'America/Los_Angeles')).toBe('2026-10-27')
    expect((await notes.write('n', { title: 'A', content: '当前：写入' })).date).toBe('2026-10-28')
    await expect(notes.read('n', { date: '2026-02-30' })).rejects.toThrow('有效')
    expect(() => resolveConfig({ database: 'db', dailyNotesTimeZone: 'invalid' })).toThrow()
    expect(() => resolveConfig({ database: 'db', dailyNotesContextMaxChars: NaN })).toThrow()
  })
  it.each(['sk-123456789abcd', 'password="abc"', 'Authorization: Bearer abcd', '-----BEGIN PRIVATE KEY-----'])('rejects credentials: %s', async content => {
    const { notes } = await fixture()
    await expect(notes.write('n', { title: 'A', content })).rejects.toThrow('未保存：内容疑似包含凭据或密钥，请删除敏感内容后重试。')
    expect((await notes.read('n')).dates).toEqual([])
  })
  it('reads full dates, paginated keyword matches and date/title lists without batches', async () => {
    const { notes } = await fixture()
    for (let d = 1; d <= 31; d++) await notes.write('n', { date: `2026-10-${String(d).padStart(2, '0')}`, title: `事项${d}`, content: '当前：SQLite 验证通过' })
    expect((await notes.read('n')).dates).toHaveLength(30)
    expect((await notes.read('n')).nextOffset).toBe(30)
    expect((await notes.read('n', { offset: 30 })).dates).toEqual([{ date: '2026-10-01', titles: ['事项1'] }])
    const search = await notes.read('n', { query: 'sqlite' })
    expect(search.matches).toHaveLength(30); expect(search.note).toBe(DAILY_NOTE_LABEL)
    expect(JSON.stringify(search)).not.toContain('batchId')
    expect((await notes.read('n', { date: '2026-10-01', query: '验证' })).matches).toHaveLength(1)
    expect((await notes.read('n', { date: '2026-10-01' })).content).toContain('SQLite')
    await expect(notes.read('n', { date: '2026-09-01' })).rejects.toThrow()
  })
  it('propagates directory and file read failures instead of empty results', async () => {
    const { root, notes } = await fixture()
    await mkdir(join(root, 'daily')); await writeFile(notes.directory('n'), 'not a directory')
    await expect(notes.read('n')).rejects.toThrow()
    await expect(notes.snapshot('n')).rejects.toThrow()
    const memory = new DailyNotes(':memory:')
    await expect(memory.read('n')).rejects.toThrow(':memory:')
    await expect(memory.write('n', { title: 'A', content: 'x' })).rejects.toThrow(':memory:')
  })
  it('leaves the original intact and cleans temporary files when backup fails', async () => {
    const { notes } = await fixture(); const date = '2026-10-28'
    await notes.write('n', { date, title: 'A', content: '当前：原文' })
    const path = join(notes.directory('n'), `${date}.md`)
    await mkdir(`${path}.bak`)
    await expect(notes.write('n', { date, title: 'B', content: '当前：新增' })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('# 2026-10-28\n\n## A\n当前：原文\n')
    expect((await readdir(notes.directory('n'))).filter(name => name.includes('.tmp'))).toEqual([])
  })
  it('rejects overlapping matches and serializes a shared file across store instances', async () => {
    const { root, notes } = await fixture(); const date = '2026-10-28'
    const other = new DailyNotes(join(root, 'memory.db'))
    await Promise.all([notes.write('n', { date, title: 'A', content: 'aaa' }), other.write('n', { date, title: 'B', content: '第二项' })])
    await expect(notes.write('n', { date, title: 'A', old_text: 'aa', content: 'b' })).rejects.toThrow('匹配到 2 处')
    expect((await notes.read('n', { date })).content).toContain('## B')
  })
  it.each([1, 7, 30])('injects the configured %s note dates and preserves older files', async days => {
    const { root, notes } = await fixture()
    for (let d = 1; d <= 31; d++) await notes.write('n', { date: `2026-10-${String(d).padStart(2, '0')}`, title: 'A', content: 'progress' })
    const configured = new DailyNotes(join(root, 'memory.db'), 'Asia/Shanghai', 12_000, days)
    const snapshot = await configured.snapshot('n')
    expect((snapshot.match(/^# 2026-/gm) || []).length).toBe(days)
    expect(snapshot).toContain('# 2026-10-31')
    expect(snapshot).not.toContain('# 2026-10-01')
    expect((await notes.read('n', { date: '2026-10-01' })).content).toContain('progress')
    const bounded = await new DailyNotes(join(root, 'memory.db'), 'Asia/Shanghai', 1024, days).snapshot('n')
    expect(bounded.length).toBeLessThanOrEqual(1024)
  })
  it('injects only three most recent dates with no lookback cutoff, truncating oldest items first', async () => {
    const { notes } = await fixture(1800)
    for (const date of ['2020-01-01', '2020-02-01', '2021-03-01', '2026-10-28']) await notes.write('n', { date, title: date, content: '当前：' + '进展'.repeat(250) })
    const snapshot = await notes.snapshot('n')
    expect(snapshot).toContain('Today:'); expect(snapshot).toContain('(Asia/Shanghai)')
    expect(snapshot).toContain('# 2026-10-28'); expect(snapshot).not.toContain('2020-01-01')
    expect(snapshot).toContain('[Omitted for length: 2020-02-01 (1 items: 《2020-02-01》…)')
    expect(snapshot.length).toBeLessThanOrEqual(1800)
  })
})

describe('daily DSH integration', () => {
  it.each([true, false])('registers tools and approved protocol only when enabled=%s', async enabled => {
    const { root, notes } = await fixture(); const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
      await ctx.plugin(plugin, { database: join(root, 'memory.db'), namespaceMode: 'global', dailyNotesEnabled: enabled, dailyNotesInjectionDays: 7 })
      const makeSession = (id: string) => ({ id, header: { cwd: root }, snapshotEvents: () => [], eventAt: () => undefined, deriveMessages: () => [] }) as unknown as Session
      const session = makeSession('daily-1'); const agent = { session } as Agent
      const assemble = (agent: Agent) => ctx.systemPrompt.assemble({ agent })
      const prompt = await assemble(agent)
      const protocol = prompt.sections.find(section => section.name === 'tool:stratagate-memory')!.text
      expect(protocol.includes('Daily notes:')).toBe(enabled)
      expect(protocol.includes('Use memory_search_graph for')).toBe(false)
      expect(ctx.tools.get('memory_remember')!.description.includes('正在推进的工作进展')).toBe(enabled)
      expect(Boolean(ctx.tools.get('memory_daily_write'))).toBe(enabled)
      expect(Boolean(ctx.tools.get('memory_daily_read'))).toBe(enabled)
      expect(prompt.contexts.some(context => context.name === 'stratagate:daily-notes')).toBe(false)
      if (!enabled) return
      expect(protocol).toContain('Notes from the 7 most recent dates')
      const execute = (name: string, args: object) => ctx.tools.get(name)!.execute(args as never, { agent, callId: 'daily-call' } as never)
      await execute('memory_daily_write', { date: '2026-10-28', title: 'A', content: '当前：原始' })
      // Empty first snapshot is fixed too.
      expect((await assemble(agent)).contexts.some(context => context.name === 'stratagate:daily-notes')).toBe(false)
      for (let d = 1; d <= 8; d++) await execute('memory_daily_write', { date: `2026-10-${String(d).padStart(2, '0')}`, title: 'A', content: 'earlier progress' })
      const other = { session: makeSession('daily-2') } as Agent
      const context = (await assemble(other)).contexts.find(context => context.name === 'stratagate:daily-notes')!.text
      expect(context).toContain('当前：原始')
      expect((context.match(/^# 2026-/gm) || []).length).toBe(7)
      expect(context).not.toContain('# 2026-10-02')
      await execute('memory_daily_write', { date: '2026-10-28', title: 'A', old_text: '原始', content: '更新' })
      expect((await assemble(other)).contexts.find(context => context.name === 'stratagate:daily-notes')!.text).toBe(context)
      const read = await execute('memory_daily_read', { date: '2026-10-28' })
      expect(read).not.toHaveProperty('batchId')
      // Actual finalization hook must neither steer nor block after this read.
      const steer = vi.fn()
      await ctx.parallel('agent/turn-stopping', { agent: { session, steer }, turn: 1 } as never)
      expect(steer).not.toHaveBeenCalled()
      ctx.emit('session/disposed', other.session)
      expect((await assemble(other)).contexts.find(context => context.name === 'stratagate:daily-notes')!.text).toContain('当前：更新')
      const dreaming = { session: makeSession('stratagate-dreaming:test') } as Agent
      expect((await assemble(dreaming)).contexts.some(context => context.name === 'stratagate:daily-notes')).toBe(false)
      // Broken storage generates a failure snapshot and never disguises it as empty.
      await rm(notes.directory('dsh:global:global'), { recursive: true }); await writeFile(notes.directory('dsh:global:global'), 'broken')
      const failed = await assemble({ session: makeSession('daily-failure') } as Agent)
      expect(failed.contexts.find(context => context.name === 'stratagate:daily-notes')!.text).toContain('This is a read failure, not an empty record.')
    } finally { await ctx.fiber.dispose() }
  })
  it('retains L5 tool originals but strips daily bodies from readable and Event extraction inputs', () => {
    const messages: RawMessage[] = [{ id: '1', role: 'assistant', content: '记录进度', createdAt: new Date().toISOString(), toolCalls: [
      { name: 'memory_daily_write', arguments: { date: '2026-10-28', title: 'A', content: 'BODY_NOT_FOR_EVENT', old_text: 'STALE_BODY' }, result: { date: '2026-10-28', content: 'RESULT_BODY' } },
      { name: 'memory_daily_read', arguments: { query: 'SQLite' }, result: { content: 'READ_BODY' } },
    ] }]
    const layers = deterministicBlockLayers(messages)
    for (const text of [layers.l3Condensed, layers.l4Readable, JSON.stringify(buildMemoryDerivationMessages(messages))]) {
      expect(text).toContain('更新了 2026-10-28 日记：《A》'); expect(text).toContain('读取了每日笔记（SQLite）')
      expect(text).not.toMatch(/BODY_NOT_FOR_EVENT|STALE_BODY|RESULT_BODY|READ_BODY/)
    }
    expect(layers.l5Raw).toEqual(messages)
    const folder = new TurnFolder(); const session = { id: 'fold' } as Session
    const event = (type: string, data: unknown) => ({ type, data, time: Date.now(), seq: 1 }) as never
    folder.accept(session, event('turn/start', { turn: 1 }))
    folder.accept(session, event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '工作' }] }))
    folder.accept(session, event('tool/call', { turn: 1, callId: 'daily', name: 'memory_daily_write', arguments: JSON.stringify(messages[0]!.toolCalls![0]!.arguments) }))
    const folded = folder.accept(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(folded!.assistantToolCalls![0]!.arguments!.content).toBe('BODY_NOT_FOR_EVENT')
  })
  it('never selects a raw fallback for tiny daily calls and compacts named JSON tool records', () => {
    const message: RawMessage = { id: 'tiny', role: 'assistant', content: '', createdAt: '', toolCalls: [{ name: 'memory_daily_read' }] }
    const layers = deterministicBlockLayers([message])
    expect(layers.l4Readable).toBe('读取了每日笔记（最近日期）')
    const raw = { id: 'json', createdAt: '', role: 'tool' as const, content: JSON.stringify({ name: 'memory_daily_read', arguments: { date: '2026-10-28' }, result: { content: 'PRIVATE_DAILY_BODY' } }) }
    expect(JSON.stringify(buildMemoryDerivationMessages([raw]))).not.toContain('PRIVATE_DAILY_BODY')
    expect(deterministicBlockLayers([raw]).l3Condensed).toContain('读取了每日笔记（2026-10-28）')
  })
})
