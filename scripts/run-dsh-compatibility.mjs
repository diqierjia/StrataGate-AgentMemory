import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

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

const hostRoot = mkdtempSync(join(tmpdir(), `stratagate-dsh-compat-${version.replaceAll('.', '_')}-`))
try {
  run(npm, ['init', '--yes'], hostRoot)
  // Resolve the selected CLI in a clean root so npm selects its matching
  // internal peer tree instead of the repository's normal runtime tree.
  run(npm, ['install', '--no-save', '--package-lock=false', `@deepseek-ai/dsh@${version}`], hostRoot)
  const dshRoot = join(hostRoot, 'node_modules')
  if (!existsSync(join(dshRoot, '@deepseek-ai', 'dsh'))) throw new Error(`DSH CLI ${version} was not installed`)
  const env = { DSH_VERSION: version, DSH_ROOT: hostRoot, NODE_PATH: dshRoot }
  for (const script of ['check:dsh', 'test:dsh', 'build:dsh', 'verify:dsh']) {
    run(npm, ['run', script], packageRoot, env)
  }
} finally {
  rmSync(hostRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}
