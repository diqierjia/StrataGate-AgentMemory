import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { internalPackageSpecs, seedPackageInstallFromIsolate, validateIsolateTree, writeDependencySpecs } from './dsh-cli-isolate.mjs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

function hostModulesForSpecs() {
  const configured = process.env.DSH_ROOT
  const configuredCli = configured && join(configured, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  return join(configuredCli && existsSync(configuredCli) ? configured : packageRoot, 'node_modules')
}

function installHostPeers(installRoot) {
  const dshVersion = process.env.DSH_VERSION
  if (!dshVersion) return
  const started = Date.now()
  const isolateRoot = process.env.DSH_ROOT
  const reusable = isolateRoot ? validateIsolateTree(isolateRoot, dshVersion, packageRoot) : { ok: false, reason: 'DSH_ROOT unset' }
  if (reusable.ok) {
    try {
      const sentinel = seedPackageInstallFromIsolate(isolateRoot, installRoot, dshVersion, packageRoot)
      console.log(`[verify-package] reused isolated CLI ${dshVersion} packages=${sentinel.packageCount} seconds=${((Date.now() - started) / 1000).toFixed(1)}`)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      console.log(`[verify-package] isolated CLI reuse failed (${message}); installing internal packages in one shot`)
      rmSync(join(installRoot, 'node_modules'), { recursive: true, force: true })
      rmSync(join(installRoot, '.stratagate-dsh-isolate.json'), { force: true })
    }
  } else if (isolateRoot) {
    console.log(`[verify-package] isolated CLI not reusable (${reusable.reason}); installing internal packages in one shot`)
  }
  const specs = internalPackageSpecs(hostModulesForSpecs())
  writeDependencySpecs(join(installRoot, 'package.json'), [{ name: '@deepseek-ai/dsh', version: dshVersion }, ...specs])
  console.log(`[verify-package] one-shot install of ${specs.length + 1} packages`)
  const shot = Date.now()
  run(['install', '--ignore-scripts', '--package-lock=false', '--legacy-peer-deps'], installRoot)
  console.log(`[verify-package] one-shot finished seconds=${((Date.now() - shot) / 1000).toFixed(1)}`)
}

let tarball
let installRoot
let ownsTarball = false
try {
  installRoot = mkdtempSync(join(tmpdir(), 'stratagate-dsh-pack-'))
  let packed
  if (process.argv[2]) {
    tarball = resolve(process.argv[2])
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    assert(listing.status === 0, `Cannot list supplied tarball: ${listing.stderr}`)
    const paths = listing.stdout.split(/\r?\n/).filter(Boolean)
    assert(paths.every(path => path.startsWith('package/') && !path.split('/').includes('..')), 'Unexpected tarball path')
    packed = { filename: basename(tarball), entryCount: paths.length, files: paths.map(path => ({ path: path.slice('package/'.length) })) }
  } else {
    const packOutput = run(['pack', '--json', '--ignore-scripts', '--pack-destination', installRoot], packageRoot)
    const jsonStart = Math.max(packOutput.lastIndexOf('\n['), packOutput.startsWith('[') ? 0 : -1)
    assert(jsonStart >= 0, `npm pack did not return JSON:\n${packOutput}`)
    packed = JSON.parse(packOutput.slice(jsonStart).trim())[0]
    tarball = join(installRoot, packed.filename)
    ownsTarball = true
  }
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
    // The README links to this published benchmark report, explicitly listed
    // in package.json. Other benchmark and development files remain forbidden.
    const publishedReport = path === 'benchmarks/locomo-conv26-r8-final.json'
    assert(publishedReport || !/^(src|tests|scripts|benchmarks)\//.test(path), `Development file leaked into package: ${path}`)
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

  run(['init', '--yes'], installRoot)
  installHostPeers(installRoot)
  const tarballStarted = Date.now()
  run(['install', tarball, '--ignore-scripts', '--package-lock=false', '--legacy-peer-deps'], installRoot)
  console.log(`[verify-package] tarball install seconds=${((Date.now() - tarballStarted) / 1000).toFixed(1)}`)
  const installed = join(installRoot, 'node_modules', 'stratagate-dsh')
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert(installedManifest.name === manifest.name && installedManifest.version === manifest.version, 'Installed package name/version does not match source')
  for (const path of required) assert(existsSync(join(installed, path)), `Clean install is missing ${path}`)
  // Without DSH_VERSION this stays a bare install: optional DSH peers are
  // absent. With DSH_VERSION the host packages are already in the tree so the
  // tarball install does not fetch a newer prerelease. Runtime import is
  // covered by verify-dsh-install.mjs.
  console.log(`Verified ${packed.filename}: ${packed.entryCount} files and clean tarball install passed.`)
} finally {
  if (installRoot) rmSync(installRoot, { recursive: true, force: true })
  if (tarball && ownsTarball) rmSync(tarball, { force: true })
}
