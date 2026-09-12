import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import {
  migrateLegacyCitationSessions,
  prepareLegacyCitationGeneration,
  scanZstdFrames,
} from '../src/legacy-session.js'

const fixturePath = join(import.meta.dirname, 'fixtures', 'legacy-session-v0', 'session.jsonl')
const modules = {
  releasedV0SessionFormatCodec,
  releasedV1SessionFormatCodec,
  sessionFormatV0ToV1,
  sessionFormatCatalog,
}

function platformFixture(source: Buffer): Buffer {
  const cwd = process.platform === 'win32' ? 'C:\\redacted\\workspace' : '/redacted/workspace'
  const text = source.toString('utf8').replace(/("cwd":)"[^"]*"/, `$1${JSON.stringify(cwd)}`)
  return Buffer.from(text)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function conversationText(events: readonly any[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'user/message') return event.data.content.map((block: any) => block.text).filter(Boolean)
    if (event.type === 'assistant/message') return event.data.message.content.map((block: any) => block.text).filter(Boolean)
    return []
  })
}

describe('legacy stratagate/memory-citations migration', () => {
  it('uses the official v0-to-v3 catalog without changing conversation content', async () => {
    const source = platformFixture(await readFile(fixturePath))
    const originalHash = digest(source)
    const prepared = prepareLegacyCitationGeneration(source, 'none', modules)
    expect(prepared).toBeDefined()
    expect(digest(source)).toBe(originalHash)
    expect(prepared!.citationSeqs).toEqual([6])
    expect(conversationText(prepared!.currentEvents)).toEqual([
      'Redacted user message A',
      'Redacted assistant reply A',
      'Redacted user message B',
      'Redacted assistant reply B',
    ])
    expect(prepared!.currentEvents.some((event) => event.type === 'stratagate/memory-citations')).toBe(false)
    expect(prepared!.currentEvents.some((event) => event.type === 'feedback/record')).toBe(true)
  })

  it('refuses to reinterpret a non-ignorable or surface-participating citation event', async () => {
    const source = platformFixture(await readFile(fixturePath))
    const unsafe = Buffer.from(source.toString('utf8').replace('"ignorable":true', '"ignorable":false'))
    expect(() => prepareLegacyCitationGeneration(unsafe, 'none', modules)).toThrow(/not marked ignorable/)
  })

  it('publishes an atomic v1 bridge and a recovery receipt while leaving v0 untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratagate-session-migration-'))
    const directory = join(root, 'redacted-project', 'fixture-session')
    await mkdir(directory, { recursive: true })
    const source = platformFixture(await readFile(fixturePath))
    const sourcePath = join(directory, 'session.jsonl')
    await writeFile(sourcePath, source)
    const before = digest(await readFile(sourcePath))

    const result = await migrateLegacyCitationSessions(root)
    expect(result).toEqual({ scanned: 1, migrated: 1, skipped: 0, failures: [] })
    expect(digest(await readFile(sourcePath))).toBe(before)
    const target = await readFile(join(directory, 'session.v1.jsonl'), 'utf8')
    expect(target).toContain('"version":1')
    expect(target).toContain('"type":"feedback/record"')
    expect(target).not.toContain('stratagate/memory-citations')
    const receipt = JSON.parse(await readFile(join(directory, 'stratagate-legacy-citations-v1.json'), 'utf8'))
    expect(receipt.sourceSha256).toBe(before)
    expect(receipt.targetSha256).toBe(digest(Buffer.from(target)))
    expect(receipt.recovery).toContain('unchanged session.jsonl')

    expect(await migrateLegacyCitationSessions(root)).toEqual({ scanned: 1, migrated: 0, skipped: 1, failures: [] })
  })

  it('preserves concatenated zstd generations and validates every frame', async () => {
    const source = platformFixture(await readFile(fixturePath))
    const newline = source.indexOf(10) + 1
    const options = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
    const compressed = Buffer.concat([
      zlib.zstdCompressSync(source.subarray(0, newline), options),
      zlib.zstdCompressSync(source.subarray(newline), options),
    ])
    expect(scanZstdFrames(compressed)).toHaveLength(2)
    const prepared = prepareLegacyCitationGeneration(compressed, 'zstd', modules)
    expect(prepared).toBeDefined()
    expect(scanZstdFrames(prepared!.bytes)).toHaveLength(2)
    expect(conversationText(prepared!.currentEvents)).toHaveLength(4)
  })
})
