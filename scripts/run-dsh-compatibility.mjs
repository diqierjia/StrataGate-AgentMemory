import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { ensureIsolateCli } from './dsh-cli-isolate.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const version = process.env.DSH_VERSION
const supported = version && evaluatePluginCompatibility(manifest, {}, version) === undefined
if (!version || (!manifest.dshWorkshop.compatibility.dshVersions.includes(version) && !supported)) {
  throw new Error('DSH_VERSION must be a recorded legacy verification host or satisfy the declared DSH compatibility range below 0.3.0-0; prereleases within that range are included')
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: process.platform === 'win32' && command === npm,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
}

const persistentRoot = process.env.DSH_ISOLATE_ROOT
const hostRoot = persistentRoot || mkdtempSync(join(tmpdir(), `stratagate-dsh-compat-${version.replaceAll('.', '_')}-`))
try {
  // One pinned CLI tree feeds the suite, package check, and install smoke.
  // A restored cache that fails validation is deleted and installed again.
  ensureIsolateCli({ root: hostRoot, version, packageRoot })
  const dshRoot = join(hostRoot, 'node_modules')
  if (!existsSync(join(dshRoot, '@deepseek-ai', 'dsh'))) throw new Error(`DSH CLI ${version} was not installed`)
  const env = { DSH_VERSION: version, DSH_ROOT: hostRoot, NODE_PATH: dshRoot }
  for (const script of ['check:dsh', 'test:dsh', 'build:dsh', 'verify:dsh']) {
    const started = Date.now()
    run(npm, ['run', script], packageRoot, env)
    console.log(`[dsh-compat] ${script} seconds=${((Date.now() - started) / 1000).toFixed(1)}`)
  }
} finally {
  if (!persistentRoot) rmSync(hostRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}
