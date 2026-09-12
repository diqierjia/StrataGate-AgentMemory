import * as zlib from 'node:zlib'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { encodeSeqRanges } from '@deepseek-ai/dsh-session'
import type {
  SessionFormatEvent,
  SessionFormatJsonObject,
  SessionFormatMigrationContext,
} from '@deepseek-ai/dsh-session-format'

const LEGACY_EVENT_TYPE = 'stratagate/memory-citations'
const COMPAT_EVENT_TYPE = 'feedback/record'
const ZSTD_MAGIC = 0xfd2fb528
const V0_PLAIN = 'session.jsonl'
const V0_ZSTD = 'session.jsonl.zstd'
const V1_PLAIN = 'session.v1.jsonl'
const V1_ZSTD = 'session.v1.jsonl.zstd'
const RECEIPT_FILENAME = 'stratagate-legacy-citations-v1.json'

interface MigrationModules {
  releasedV0SessionFormatCodec: {
    createDecoder(header: unknown, recovery: 'strict'): {
      header: Record<string, unknown>
      headerInheritedEventCount?: number
      decodeRow(row: unknown, context: SessionFormatMigrationContext): void
      finish(context: SessionFormatMigrationContext): number
    }
  }
  releasedV1SessionFormatCodec: {
    decodeHeader(header: unknown): unknown
  }
  sessionFormatV0ToV1: {
    migrateHeader(header: any): any
    createStage(input: any): {
      transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void
      transformRun(run: any, context: SessionFormatMigrationContext): void
      finish(context: SessionFormatMigrationContext): number
    }
    validateTargetHeader(header: unknown): void
  }
  sessionFormatCatalog: {
    createRestore(header: unknown, options: { recovery: 'strict'; validation: 'transformed' }): {
      decodeRow(row: unknown): void
      finish(): { events: readonly SessionFormatEvent[] }
    }
  }
}

export interface LegacySessionMigrationResult {
  scanned: number
  migrated: number
  skipped: number
  failures: ReadonlyArray<{ path: string; error: string }>
}

interface PreparedGeneration {
  bytes: Buffer
  citationSeqs: number[]
  currentEvents: readonly SessionFormatEvent[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Locate complete concatenated Zstandard frames without decoding their blocks. */
export function scanZstdFrames(buffer: Buffer): ReadonlyArray<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5) throw new Error(`incomplete Zstandard frame at byte ${start}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`incomplete Zstandard frame header at byte ${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`incomplete Zstandard block header at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error(`incomplete Zstandard block at byte ${start}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`incomplete Zstandard checksum at byte ${start}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function decodeGeneration(bytes: Buffer, compression: 'none' | 'zstd'): Buffer {
  if (compression === 'none') return bytes
  return Buffer.concat(scanZstdFrames(bytes).map(({ start, end }) => (
    zlib.zstdDecompressSync(bytes.subarray(start, end))
  )))
}

function encodeGeneration(header: SessionFormatJsonObject, rows: readonly SessionFormatJsonObject[], compression: 'none' | 'zstd'): Buffer {
  const headerLine = Buffer.from(`${JSON.stringify(header)}\n`)
  const body = Buffer.from(rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  if (compression === 'none') return Buffer.concat([headerLine, body])
  const options = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
  return Buffer.concat([
    zlib.zstdCompressSync(headerLine, options),
    ...(body.length === 0 ? [] : [zlib.zstdCompressSync(body, options)]),
  ])
}

function physicalV1Event(event: SessionFormatEvent): SessionFormatJsonObject {
  const output = { ...event } as Record<string, any>
  if (Array.isArray(output.sourceEventSeqs)) output.sourceEventSeqs = encodeSeqRanges(output.sourceEventSeqs)
  return output
}

function compatibilityEvent(event: SessionFormatEvent): SessionFormatEvent {
  if (event.ignorable !== true) {
    throw new Error(`${LEGACY_EVENT_TYPE} at seq ${event.seq} is not marked ignorable; refusing an unsafe conversion`)
  }
  if ('surfaceOp' in event || 'sourceEventSeqs' in event) {
    throw new Error(`${LEGACY_EVENT_TYPE} at seq ${event.seq} unexpectedly participates in the conversation surface`)
  }
  return {
    ...event,
    type: COMPAT_EVENT_TYPE,
    data: { text: 'StrataGate legacy citation metadata omitted during Session format migration.' },
  }
}

function parseJsonLines(plain: Buffer): unknown[] {
  if (plain.length === 0 || plain.at(-1) !== 10) throw new Error('Session generation does not end at a complete JSONL record')
  const text = plain.toString('utf8')
  const lines = text.slice(0, -1).split('\n')
  if (lines.length === 0 || lines[0] === '') throw new Error('Session generation has no header')
  return lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid Session JSONL record ${index}`, { cause: error })
    }
  })
}

export function prepareLegacyCitationGeneration(
  sourceBytes: Buffer,
  compression: 'none' | 'zstd',
  modules: MigrationModules,
): PreparedGeneration | undefined {
  const values = parseJsonLines(decodeGeneration(sourceBytes, compression))
  const [headerValue, ...rowValues] = values
  if (!isRecord(headerValue) || headerValue.version !== 0) return undefined
  if (!rowValues.some((row) => isRecord(row) && row.type === LEGACY_EVENT_TYPE)) return undefined

  const decoder = modules.releasedV0SessionFormatCodec.createDecoder(headerValue, 'strict')
  const targetHeader = modules.sessionFormatV0ToV1.migrateHeader(decoder.header)
  modules.sessionFormatV0ToV1.validateTargetHeader(targetHeader)
  const stage = modules.sessionFormatV0ToV1.createStage({
    sourceHeader: decoder.header,
    targetHeader,
    sourceInheritedEventCount: decoder.headerInheritedEventCount,
    sourceKind: 'decoded',
  })
  const outputRows: SessionFormatJsonObject[] = []
  const citationSeqs: number[] = []
  let physicalRow: unknown
  const stageContext: SessionFormatMigrationContext = {
    emitEvent(event) { outputRows.push(physicalV1Event(event)) },
    emitRun() {
      if (!isRecord(physicalRow)) throw new Error('DSH emitted a packed run without its physical source row')
      outputRows.push(physicalRow)
    },
  }
  const decodeContext: SessionFormatMigrationContext = {
    emitEvent(event) {
      if (event.type === LEGACY_EVENT_TYPE) {
        citationSeqs.push(event.seq)
        stage.transformEvent(compatibilityEvent(event), stageContext)
      } else {
        stage.transformEvent(event, stageContext)
      }
    },
    emitRun(run) { stage.transformRun(run, stageContext) },
  }
  for (const row of rowValues) {
    physicalRow = row
    decoder.decodeRow(row, decodeContext)
  }
  const decodedCut = decoder.finish(decodeContext)
  const migratedCut = stage.finish(stageContext)
  if (decodedCut !== migratedCut) throw new Error('StrataGate compatibility migration changed the inherited Session cut')

  const physicalHeader = { ...headerValue, version: 1 } as SessionFormatJsonObject
  modules.releasedV1SessionFormatCodec.decodeHeader(physicalHeader)
  const restore = modules.sessionFormatCatalog.createRestore(physicalHeader, {
    recovery: 'strict',
    validation: 'transformed',
  })
  for (const row of outputRows) restore.decodeRow(row)
  const current = restore.finish()
  return {
    bytes: encodeGeneration(physicalHeader, outputRows, compression),
    citationSeqs,
    currentEvents: current.events,
  }
}

async function loadMigrationModules(): Promise<MigrationModules | undefined> {
  try {
    const [edge, catalog] = await Promise.all([
      import('@deepseek-ai/dsh-session-format-v0-to-v1'),
      import('@deepseek-ai/dsh-session-format-catalog'),
    ])
    return {
      releasedV0SessionFormatCodec: edge.releasedV0SessionFormatCodec,
      releasedV1SessionFormatCodec: edge.releasedV1SessionFormatCodec,
      sessionFormatV0ToV1: edge.sessionFormatV0ToV1,
      sessionFormatCatalog: catalog.sessionFormatCatalog,
    } as MigrationModules
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  }
}

async function sessionDirectories(root: string): Promise<string[]> {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const output: string[] = []
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectPath = join(root, project.name)
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      if (session.isDirectory() && !session.isSymbolicLink()) output.push(join(projectPath, session.name))
    }
  }
  return output
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function publishExclusive(path: string, bytes: Buffer): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.stratagate-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    // Some filesystems do not provide hard links. COPYFILE_EXCL still preserves
    // the no-overwrite guarantee; the fully synced temporary remains the source.
    if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'ENOTSUP') {
      try {
        await copyFile(temporary, path, fsConstants.COPYFILE_EXCL)
        return true
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw copyError
      }
    }
    throw error
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function writeReceipt(directory: string, sourcePath: string, targetPath: string, source: Buffer, target: Buffer, citationSeqs: readonly number[]): Promise<void> {
  const receipt = {
    schema: 'stratagate-legacy-citations-migration/v1',
    source: basename(sourcePath),
    sourceSha256: sha256(source),
    target: basename(targetPath),
    targetSha256: sha256(target),
    convertedEventType: LEGACY_EVENT_TYPE,
    replacementEventType: COMPAT_EVENT_TYPE,
    citationSeqs,
    recovery: `Delete ${basename(targetPath)} only while DSH is stopped to make the unchanged ${basename(sourcePath)} generation authoritative again.`,
  }
  await writeFile(join(directory, RECEIPT_FILENAME), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
}

/**
 * Publish a validated v1 bridge for v0 sessions containing StrataGate's retired
 * citation event. The immutable v0 generation is never changed or removed.
 */
export async function migrateLegacyCitationSessions(sessionRoot: string | undefined): Promise<LegacySessionMigrationResult> {
  const result: LegacySessionMigrationResult = { scanned: 0, migrated: 0, skipped: 0, failures: [] }
  if (!sessionRoot) return result
  const modules = await loadMigrationModules()
  // DSH 0.1.2 has no released-format migration catalog and needs no bridge.
  if (!modules) return result

  for (const directory of await sessionDirectories(sessionRoot)) {
    const candidates = [
      { source: join(directory, V0_ZSTD), target: join(directory, V1_ZSTD), compression: 'zstd' as const },
      { source: join(directory, V0_PLAIN), target: join(directory, V1_PLAIN), compression: 'none' as const },
    ]
    for (const candidate of candidates) {
      if (!(await exists(candidate.source))) continue
      result.scanned += 1
      if (await exists(candidate.target)) {
        result.skipped += 1
        continue
      }
      try {
        const source = await readFile(candidate.source)
        const prepared = prepareLegacyCitationGeneration(source, candidate.compression, modules)
        if (!prepared) {
          result.skipped += 1
          continue
        }
        if (await publishExclusive(candidate.target, prepared.bytes)) {
          await writeReceipt(directory, candidate.source, candidate.target, source, prepared.bytes, prepared.citationSeqs)
          result.migrated += 1
        } else {
          result.skipped += 1
        }
      } catch (error) {
        ;(result.failures as Array<{ path: string; error: string }>).push({ path: candidate.source, error: errorText(error) })
      }
    }
  }
  return result
}
