// Synthetic provider comparison. No user database, credentials, or paid model calls.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = process.cwd()
const baseline = process.argv[2] ?? 'HEAD'
const revision = execFileSync('git', ['rev-parse', baseline], { encoding: 'utf8' }).trim()
const directory = resolve(root, '.benchmarks/event-extraction-reliability-20261029')
await mkdir(directory, { recursive: true })
const oldCode = execFileSync('git', ['show', `${revision}:src/llm.ts`], { encoding: 'utf8', maxBuffer: 2 ** 22 })
const newCode = await readFile(resolve(root, 'src/llm.ts'), 'utf8')
const modules = {}
for (const [name, contents] of [['baseline', oldCode], ['current', newCode]]) {
  const outfile = resolve(directory, `${name}.mjs`)
  await build({ stdin: { contents, resolveDir: resolve(root, 'src'), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  modules[name] = (await import(pathToFileURL(outfile).href)).DshModelBridge
}
const { estimateTokens } = await import('@diqier/stratagate')
const stamp = '2026-10-29T20:00:00+08:00'
const source = (content, id) => ({ id, content, role: 'user', createdAt: stamp })
const cases = [
  { name: 'ordinary', messages: [source('FACT[1]:SQLite.\n', 'one')], expected: ['1'] },
  { name: 'oversized-input', messages: [source('背景信息。\n'.repeat(1_600) + 'FACT[1]:SQLite.\n'
    + '背景信息。\n'.repeat(1_600) + 'FACT[2]:User correction.\n', 'large')], expected: ['1', '2'] },
  { name: 'output-budget', messages: Array.from({ length: 5 }, (_, i) => source(`FACT[${i}]:Independent fact ${i}.\n`, `msg_${i}`)),
    expected: ['0', '1', '2', '3', '4'] },
  { name: 'complete-json-with-truncation', messages: [source('FACT[1]:SQLite.\n', 'one'), source('FACT[2]:Correction.\n', 'two')], expected: ['1', '2'] },
]
const results = []
for (const [implementation, Bridge] of Object.entries(modules)) {
  for (const test of cases) {
    const requests = []
    const acceptedSources = []
    const ctx = { logger: { warn() {} }, llm: {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] }, context: { contextWindow: 32_768 } }),
      stream: request => (async function* () {
        const input = estimateTokens(JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages }))
        const payload = JSON.parse(request.messages[0].content[0].text)
        const record = { estimatedInputTokens: input, outputLimit: request.maxTokens, payload, accepted: false }
        requests.push(record)
        if (input > 12_000) throw new Error('synthetic provider context limit')
        let events = payload.target.messages.flatMap(message => [...message.content.matchAll(/FACT\[(\d+)\]:([^\n]+)/g)].map(match => ({
          title: `Fact ${match[1]}`, summary: match[2], tags: [match[1]], sourceMessageIds: [message.id], scope: 'project',
        })))
        const truncated = test.name === 'complete-json-with-truncation' && requests.length === 1
          || test.name === 'output-budget' && request.maxTokens < 4_096
        if (truncated) events = events.slice(0, 1)
        else { record.accepted = true; acceptedSources.push(...payload.target.messages) }
        const json = JSON.stringify({ shouldExtract: events.length > 0, reason: 'synthetic fixture', events })
        if (test.name === 'complete-json-with-truncation') yield { type: 'text-delta', index: 0, text: json }
        else yield { type: 'tool-call-delta', index: 0, id: 'mock', name: 'stratagate_extract_event_cards', argumentsDelta: json }
        yield { type: 'finish', reason: { kind: truncated ? 'max-tokens' : 'stop' } }
      })(),
    } }
    const bridge = new Bridge(ctx, { database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2_048 })
    const session = { id: 'comparison', requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }
    const context = { previous: null, next: null, timeline: [], target: {
      id: 'block', sequence: 1, startTurn: 1, endTurn: 1, createdAt: stamp, l3Condensed: '', l4Readable: '',
      l5Raw: test.messages, shouldExtract: true, processingStatus: 'pending', pointerCurrentLevel: 5,
      pointerAnchorLevel: 5, pointerAnchorBlockPosition: 1, lastLiftedAt: null, lastLiftedBy: null,
    } }
    let value, error
    try { value = await bridge.run(session, () => bridge.extractor(context)) } catch (caught) { error = caught.message }
    const recovered = value?.events.flatMap(event => event.tags ?? []) ?? []
    const covered = test.messages.every(message => acceptedSources.filter(item => item.id === message.id).map(item => item.content).join('') === message.content)
    results.push({ implementation, case: test.name, expectedFacts: test.expected, recoveredFacts: recovered,
      completeFacts: test.expected.every(fact => recovered.includes(fact)) && recovered.length === test.expected.length,
      sourceCoverage: covered, modelCalls: requests.length, result: value ?? null, error: error ?? null, requests })
  }
}
const hash = value => createHash('sha256').update(value).digest('hex')
await writeFile(resolve(directory, 'evidence.json'), JSON.stringify({ baselineRevision: revision,
  sourceHashes: { baselineLlm: hash(oldCode), currentLlm: hash(newCode),
    extractionBatches: hash(await readFile(resolve(root, 'src/extraction-batches.ts'))) },
  kind: 'synthetic mock-provider comparison; NOT live failure-rate or semantic-recall measurement', results }, null, 2))
console.table(results.map(({ implementation, case: name, completeFacts, sourceCoverage, modelCalls, error }) =>
  ({ implementation, case: name, completeFacts, sourceCoverage, modelCalls, failed: !!error })))
if (results.filter(result => result.implementation === 'current').some(result => !result.completeFacts || !result.sourceCoverage)) process.exitCode = 1
console.log(`Evidence: ${resolve(directory, 'evidence.json')}`)
