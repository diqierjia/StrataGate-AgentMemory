import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))

function resolveMainRepoRoot() {
  const probe = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' })
  if (probe.status === 0 && probe.stdout.trim()) {
    return resolve(root, probe.stdout.trim(), '..')
  }
  return root
}

function resolveReactRoot() {
  if (process.env.STRATAGATE_TEST_REACT_ROOT) return process.env.STRATAGATE_TEST_REACT_ROOT
  const localReact = join(root, 'release-candidates', 'first-login-browser-fixture', 'node_modules')
  if (existsSync(localReact)) return localReact
  const mainRepoRoot = resolveMainRepoRoot()
  const sharedReact = join(mainRepoRoot, 'release-candidates', 'first-login-browser-fixture', 'node_modules')
  if (existsSync(sharedReact)) {
    try {
      mkdirSync(dirname(localReact), { recursive: true })
      symlinkSync(sharedReact, localReact, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // fall through and return sharedReact directly
    }
    return sharedReact
  }
  return localReact
}

// Core browser suites that reflect the current 0.3.53+ redesigned UI and run
// out-of-the-box without external manual fixtures.
const DEFAULT_SUITES = [
  'scripts/test-real-memory-e2e-browser.mjs',
  'scripts/test-dsh-agent-e2e-browser.mjs',
  'scripts/test-dreaming-browser.mjs',
]

function resolveNodeBinary() {
  const currentMajor = Number(process.versions.node.split('.')[0])
  if (currentMajor >= 24) return { cmd: process.execPath, extraArgs: [] }
  if (typeof zlib.createZstdCompress === 'function') {
    return { cmd: process.execPath, extraArgs: ['--experimental-sqlite'] }
  }
  const candidates = [
    process.env.STRATAGATE_DSH_NODE,
    join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx', '387698761821791d', 'node_modules', 'node', 'bin', 'node.exe'),
    join(homedir(), '.workbuddy', 'binaries', 'node', 'versions', '22.22.2-6', 'node.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) {
      const is24 = c.includes('387698761821791d') || c.includes('24.')
      return { cmd: c, extraArgs: is24 ? [] : ['--experimental-sqlite'] }
    }
  }

  if (process.platform === 'win32') {
    const probe = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "(Get-Command node -All -ErrorAction SilentlyContinue | Where-Object { (& $_.Source -v) -like 'v24*' } | Select-Object -First 1).Source",
      ],
      { encoding: 'utf8' },
    )
    const found = (probe.stdout || '').trim()
    if (found && existsSync(found)) {
      return { cmd: found, extraArgs: [] }
    }
  }
  return { cmd: process.execPath, extraArgs: ['--experimental-sqlite'] }
}

const args = process.argv.slice(2)
const allScripts = readdirSync(join(root, 'scripts'))
  .filter((name) => /^test-.*-browser\.mjs$/.test(name))
  .sort()
  .map((name) => `scripts/${name}`)

if (args.includes('--list')) {
  console.log('Default browser suites (npm run test:browser):')
  for (const s of DEFAULT_SUITES) console.log(`  * ${s}`)
  console.log('\nAll available browser scripts in scripts/:')
  for (const s of allScripts) console.log(`  - ${s}`)
  process.exit(0)
}

const filters = args.filter((a) => !a.startsWith('--'))
const selectedSuites = args.includes('--all')
  ? allScripts
  : filters.length > 0
    ? allScripts.filter((s) => filters.some((f) => s.toLowerCase().includes(f.toLowerCase())))
    : DEFAULT_SUITES

if (selectedSuites.length === 0) {
  console.error(`[test:browser] No browser test scripts matched filter: ${filters.join(', ')}`)
  process.exit(1)
}

const { cmd: nodeBin, extraArgs } = resolveNodeBinary()
console.log(`[test:browser] Building & checking client via scripts/build-client.mjs...`)
const buildRes = spawnSync(nodeBin, [...extraArgs, 'scripts/build-client.mjs'], {
  cwd: root,
  stdio: 'inherit',
})
if (buildRes.status !== 0) {
  process.exit(buildRes.status ?? 1)
}

const results = []
const reactRoot = resolveReactRoot()
for (const suite of selectedSuites) {
  const started = Date.now()
  console.log(`\n[test:browser] Running ${suite}...`)
  const res = spawnSync(nodeBin, [...extraArgs, suite], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      STRATAGATE_TEST_REACT_ROOT: reactRoot,
    },
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  results.push({ suite, status: res.status ?? 1, elapsed })
  if (res.status !== 0) {
    console.error(`[test:browser] FAILED: ${suite} (${elapsed}s)`)
    process.exit(res.status ?? 1)
  }
  console.log(`[test:browser] PASSED: ${suite} (${elapsed}s)`)
}

console.log(`\n[test:browser] All ${results.length} browser suite(s) passed:`)
for (const r of results) {
  console.log(`  - ${r.suite} (${r.elapsed}s)`)
}
