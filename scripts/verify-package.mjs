import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmCli = process.env.npm_execpath

function run(args, cwd) {
  const result = spawnSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, ...args] : args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && !npmCli,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let tarball
let installRoot
try {
  const packOutput = run(['pack', '--json', '--ignore-scripts'], packageRoot)
  const jsonStart = Math.max(packOutput.lastIndexOf('\n['), packOutput.startsWith('[') ? 0 : -1)
  assert(jsonStart >= 0, `npm pack did not return JSON:\n${packOutput}`)
  const packed = JSON.parse(packOutput.slice(jsonStart).trim())[0]
  tarball = join(packageRoot, packed.filename)
  const files = new Set(packed.files.map(({ path }) => path.replaceAll('\\', '/')))
  const required = [
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'README.zh-CN.md',
    'docs/DSH.md',
    'docs/DSH.zh-CN.md',
    'screenshots.json',
    'CHANGELOG.md',
    'LICENSE',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/plugin.js',
    'dist/repair-profile.js',
    'dist/client.js',
    'dist/client.d.ts',
  ]
  for (const path of required) assert(files.has(path), `Packed artifact is missing ${path}`)
  for (const path of files) {
    assert(!/^(src|tests|scripts|benchmarks)\//.test(path), `Development file leaked into package: ${path}`)
    assert(!/\.(?:db|sqlite3?|pem|key)$/i.test(path), `Sensitive/runtime file leaked into package: ${path}`)
  }

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert(manifest.name === 'stratagate-dsh', 'Repository root is not the DSH package')
  assert(manifest.repository?.directory === undefined, 'Root package must not declare a repository subdirectory')
  assert(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'Missing DSH bundle patch metadata')
  assert(manifest.dsh?.client?.platform === 'web', 'Missing DSH web client metadata')
  assert(manifest.dshWorkshop?.integration?.protocol === 'harness-profile', 'Missing Workshop integration metadata')
  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert(patch.includes('name: stratagate-dsh'), 'Cordis patch does not install stratagate-dsh')

  installRoot = mkdtempSync(join(tmpdir(), 'stratagate-dsh-pack-'))
  run(['init', '--yes'], installRoot)
  run(['install', tarball, '--ignore-scripts', '--package-lock=false'], installRoot)
  const installed = join(installRoot, 'node_modules', 'stratagate-dsh')
  for (const path of required) assert(existsSync(join(installed, path)), `Clean install is missing ${path}`)
  // DSH core packages are optional peers and intentionally absent from this
  // bare npm project. Runtime import is covered by verify-dsh-install.mjs,
  // which installs the complete host CLI and its real dependency tree.
  console.log(`Verified ${packed.filename}: ${packed.entryCount} files and clean tarball install passed.`)
} finally {
  if (installRoot) rmSync(installRoot, { recursive: true, force: true })
  if (tarball) rmSync(tarball, { force: true })
}
