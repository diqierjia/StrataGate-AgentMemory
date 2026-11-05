/**
 * Isolated, synthetic SQLite benchmark. Never opens the user's database.
 * node scripts/benchmark-surface-assembly.mjs --base=HEAD --rounds=12
 * Baseline runtime/store are read from Git; other dependencies are shared.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { resolve, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const option = (key, fallback) => process.argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const base = option('base', 'HEAD')
const rounds = Number(option('rounds', '12'))
if (!Number.isInteger(rounds) || rounds < 3 || rounds > 100) throw new Error('--rounds must be between 3 and 100')
const out = resolve(root, '.benchmarks', `surface-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`)
await mkdir(out, { recursive: true })
const paths = ['src/runtime.ts', 'packages/core/src/store.ts']
const baseline = Object.fromEntries(paths.map((path) => [path, execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })]))
const hash = (text) => createHash('sha256').update(text).digest('hex')
const current = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(resolve(root, path), 'utf8')])))
const evidence = {
  createdAt: new Date().toISOString(), node: process.version,
  platform: `${process.platform}/${process.arch}`, baselineRef: base,
  baselineCommit: execFileSync('git', ['rev-parse', base], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: { baseline: Object.fromEntries(paths.map((path) => [path, hash(baseline[path])])), current: Object.fromEntries(paths.map((path) => [path, hash(current[path])])) },
  workload: 'Synthetic, isolated SQLite; all Blocks ready with L5 native checkpoints, decay due. No embedding or network I/O. Fixture setup excluded. A new fixture is used for every sample.',
  eventLoopMethod: 'monitorEventLoopDelay, resolution 1ms; warmed for 10ms before assembly, observed 5ms after it. Max includes scheduling delay, not just one synchronous function.',
  samples: [], summary: [],
}
const baselineEvidence = option('baseline-evidence', '')
if (baselineEvidence) {
  const path = resolve(root, baselineEvidence)
  const raw = await readFile(path, 'utf8')
  const cached = JSON.parse(raw)
  if (cached.baselineCommit !== evidence.baselineCommit || cached.node !== evidence.node || cached.platform !== evidence.platform
    || paths.some((path) => cached.sourceHashes.baseline[path] !== evidence.sourceHashes.baseline[path])) {
    throw new Error('Cached baseline uses different code or runtime')
  }
  evidence.samples.push(...cached.samples.filter((sample) => sample.mode === 'baseline'))
  evidence.summary.push(...cached.summary.filter((group) => group.mode === 'baseline'))
  evidence.reusedBaselineEvidence = { path, sha256: hash(raw), createdAt: cached.createdAt }
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)], max: sorted.at(-1) }
}

for (const mode of baselineEvidence ? ['current'] : ['baseline', 'current']) {
  const output = resolve(out, `${mode}.mjs`)
  await build({
    stdin: { contents: `export { surfaceFixture } from './tests/fixtures/surface-maintenance.ts'; export { SqliteStorage } from './packages/core/src/sqlite.ts';`, resolveDir: root, sourcefile: `${mode}-entry.ts`, loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    alias: { '@diqier/stratagate': resolve(root, 'packages/core/src/index.ts'), '@diqier/stratagate/sqlite': resolve(root, 'packages/core/src/sqlite.ts') },
    plugins: mode === 'baseline' ? [{ name: 'git-baseline', setup(builder) {
      builder.onLoad({ filter: /(?:runtime|store)\.ts$/ }, (args) => {
        const path = relative(root, args.path).replaceAll('\\', '/')
        if (baseline[path]) return { contents: baseline[path], loader: 'ts', resolveDir: resolve(root, path, '..') }
      })
    } }] : [],
    logLevel: 'silent',
  })
  const { surfaceFixture, SqliteStorage } = await import(pathToFileURL(output).href)
  for (const blocks of [20, 80, 160]) {
    for (let round = 0; round < rounds; round++) {
      const f = await surfaceFixture(blocks)
      const save = SqliteStorage.prototype.save
      let commits = 0
      let maxSaveSyncMs = 0
      SqliteStorage.prototype.save = function (...args) {
        const started = performance.now()
        const result = save.apply(this, args)
        if (args[0] === f.namespace) { commits++; maxSaveSyncMs = Math.max(maxSaveSyncMs, performance.now() - started) }
        return result
      }
      try {
        const loop = monitorEventLoopDelay({ resolution: 1 })
        loop.enable()
        await new Promise((done) => setTimeout(done, 10))
        const start = performance.now()
        await f.plugin.buildAutoContext(f.session)
        const assemblyMs = performance.now() - start
        const assemblyCommits = commits
        await new Promise((done) => setTimeout(done, 5))
        loop.disable()
        const eventLoopDelayMaxMs = loop.max / 1e6
        commits = 0
        const backgroundStart = performance.now()
        if (mode === 'current') await f.run()
        const backgroundMs = mode === 'current' ? performance.now() - backgroundStart : null
        const backgroundCommits = commits
        commits = 0
        const stableStart = performance.now()
        await f.plugin.buildAutoContext(f.session)
        const stableAssemblyMs = performance.now() - stableStart
        const stableCommits = commits
        commits = 0
        const sameLevel = f.memory.listBlocks().map(({ id, surfaceCurrentLevel }) => ({ id, level: surfaceCurrentLevel }))
        const sameStart = performance.now()
        // Replay the old caller's N single setters, including same-value writes.
        for (const { id, level } of sameLevel) await f.memory.setBlockSurfaceLevel(id, level)
        const unchangedSettersMs = performance.now() - sameStart
        evidence.samples.push({ mode, blocks, round, assemblyMs, assemblyCommits, eventLoopDelayMaxMs, maxSaveSyncMs,
          backgroundMs, backgroundCommits, stableAssemblyMs, stableCommits, unchangedSettersMs, unchangedSetterCommits: commits })
      } finally {
        SqliteStorage.prototype.save = save
        await f.dispose()
      }
    }
    const samples = evidence.samples.filter((sample) => sample.mode === mode && sample.blocks === blocks)
    const group = { mode, blocks, n: samples.length,
      assemblyMs: summary(samples.map((sample) => sample.assemblyMs)),
      eventLoopDelayMaxMs: summary(samples.map((sample) => sample.eventLoopDelayMaxMs)),
      assemblyCommits: summary(samples.map((sample) => sample.assemblyCommits)),
      stableAssemblyMs: summary(samples.map((sample) => sample.stableAssemblyMs)),
      unchangedSettersMs: summary(samples.map((sample) => sample.unchangedSettersMs)),
      unchangedSetterCommits: summary(samples.map((sample) => sample.unchangedSetterCommits)),
      ...(mode === 'current' ? { backgroundMs: summary(samples.map((sample) => sample.backgroundMs)), backgroundCommits: summary(samples.map((sample) => sample.backgroundCommits)) } : {}),
    }
    evidence.summary.push(group)
    await writeFile(resolve(out, 'results.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify(group))
  }
}
console.log(`Evidence: ${resolve(out, 'results.json')}`)
