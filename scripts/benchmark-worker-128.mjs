// Windows/Node runtime microbenchmark. Uses synthetic idle memories and detached model stubs.
// Run with Node 24: node --expose-gc scripts/benchmark-worker-128.mjs [baseline-ref]
// Baseline archive, bundles and databases stay inside this Worktree's ignored .artifacts.
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile, copyFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifacts = join(root, '.artifacts', 'issue128')
const summary = async () => ({ l0Title: 'idle', l0Tags: [], l1Summary: 'stored', l2Keypoints: [], shouldExtract: false })

if (process.argv[2] === '--measure') {
  const [bundle, database, roundsArg] = process.argv.slice(3)
  const { StrataGateRuntime, SqliteStorage } = await import(pathToFileURL(bundle).href)
  let loads = 0
  const original = SqliteStorage.prototype.load
  SqliteStorage.prototype.load = function (...args) { loads++; return original.apply(this, args) }
  const errors = []
  const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048 }, {
    isReady: () => true, onAdaptersUpdated: () => () => {}, summarizer: summary,
    extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
    graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
    runDetached: async (_id, operation) => operation(),
  }, (error) => errors.push(String(error)))
  clearTimeout(runtime.backgroundWorkerTimer); runtime.backgroundWorkerTimer = undefined
  runtime.scheduleBackgroundWorker = () => {} // Measure explicit, non-overlapping passes with the unchanged 3s sleep.
  global.gc?.()
  const rssBefore = process.memoryUsage().rss
  const cpuBefore = process.cpuUsage()
  const start = performance.now()
  const pollsMs = []
  for (let round = 0; round < Number(roundsArg); round++) {
    const began = performance.now()
    await runtime.runBackgroundWorker()
    pollsMs.push(performance.now() - began)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  const wallMs = performance.now() - start
  const cpu = process.cpuUsage(cpuBefore)
  const cpuMs = (cpu.user + cpu.system) / 1_000
  const rssAfter = process.memoryUsage().rss
  const peakRss = process.resourceUsage().maxRSS * 1024
  await runtime.close()
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(JSON.stringify({ pollsMs, meanPollMs: pollsMs.reduce((a, b) => a + b, 0) / pollsMs.length,
    fullMemoryLoads: loads, cpuMs, wallMs, processCpuPercent: cpuMs / wallMs * 100,
    rssBefore, rssAfter, peakRss, node: process.version, platform: process.platform, arch: process.arch,
    cpuMeasurementNote: 'A zero CPU delta means below Windows counter resolution in this sample, not zero actual CPU work.' }))
} else {
  const baselineRef = process.argv[2] ?? 'e954eaf2f2cbbef4bb6226a2ebb35191424868c2'
  const baselineSha = execFileSync('git', ['rev-parse', baselineRef], { cwd: root, encoding: 'utf8' }).trim()
  await mkdir(artifacts, { recursive: true })
  const baselineRoot = join(artifacts, 'baseline')
  await mkdir(baselineRoot, { recursive: true })
  const archive = join(artifacts, 'baseline.tar')
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, baselineSha], { cwd: root })
  execFileSync('tar', ['-xf', archive, '-C', baselineRoot])
  const bundles = {}
  for (const [label, source] of [['before', baselineRoot], ['after', root]]) {
    const core = join(source, 'packages', 'core', 'src')
    const outfile = join(artifacts, `${label}.mjs`)
    await build({ stdin: { contents: `export { StrataGateRuntime } from ${JSON.stringify(join(source, 'src', 'runtime.ts'))};
      export { StrataGate } from ${JSON.stringify(join(core, 'store.ts'))};
      export { SqliteStorage } from ${JSON.stringify(join(core, 'sqlite.ts'))};`, resolveDir: root, sourcefile: 'worker-benchmark-entry.ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', outfile,
    alias: { '@diqier/stratagate/sqlite': join(core, 'sqlite.ts'), '@diqier/stratagate': join(core, 'index.ts') } })
    bundles[label] = outfile
  }
  const { StrataGate } = await import(pathToFileURL(bundles.after).href)
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const results = { baselineSha, sourceSha, capturedAt: new Date().toISOString(), scope: 'Synthetic DSH runtime on Windows; not the user database or full DSH UI process.', scenarios: [] }
  for (const [name, rawChars] of [['small', 8_192], ['large', 1_572_864]]) {
    const sourceDb = join(artifacts, `${name}-seed-${Date.now()}.db`)
    for (let index = 0; index < 100; index++) {
      const memory = await StrataGate.open({ database: sourceDb, namespace: `idle:${index}`, blockTurnSize: 1, summarizer: summary })
      try { await memory.appendTurn({ user: 'history '.repeat(Math.ceil(rawChars / 8)).slice(0, rawChars), assistant: 'stored' }) }
      finally { await memory.close() }
    }
    const scenario = { name, namespaces: 100, rawUserCharsPerNamespace: rawChars, databaseBytes: (await stat(sourceDb)).size,
      rounds: 3, intervalMs: 3_000, measurements: {} }
    for (const label of ['before', 'after']) {
      const database = join(artifacts, `${name}-${label}-${Date.now()}.db`)
      await copyFile(sourceDb, database)
      if (label === 'before') {
        // Compare the old code with its old schema. Do not charge the baseline
        // for new dirty-tracking triggers installed by the fixture writer.
        const db = new DatabaseSync(database)
        try {
          const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'background_dirty_%' OR name LIKE 'raw_fts_dirty_%')").all()
          for (const { name } of triggers) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`)
          db.exec('DROP TABLE background_work_schedule; DROP TABLE background_work_dirty; DROP TABLE raw_message_fts_dirty; ALTER TABLE block_summary_jobs DROP COLUMN lease_until; ALTER TABLE extraction_jobs DROP COLUMN lease_until;')
        } finally { db.close() }
      }
      const output = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure', bundles[label], database, '3'],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        child.on('exit', (code) => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr)))
      })
      scenario.measurements[label] = output
      console.log(`${name} ${label}: ${JSON.stringify(output)}`)
    }
    results.scenarios.push(scenario)
  }
  const output = join(artifacts, 'results.json')
  await writeFile(output, JSON.stringify(results, null, 2) + '\n')
  console.log(`Raw evidence: ${output}`)
}
