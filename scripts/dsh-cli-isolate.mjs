import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { satisfies } from 'semver'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

export const SENTINEL_NAME = '.stratagate-dsh-isolate.json'
export const LEGACY_TRANSITIVE_NAMES = ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-settings-file']

const removable = { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }

function secondsSince(started) {
  return ((Date.now() - started) / 1000).toFixed(1)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function wipe(path) {
  rmSync(path, removable)
}

export function internalVersionFor(version) {
  return version === '0.1.5-rc.1' ? '0.1.5-rc.2' : version
}

export function isModernHost(version) {
  return satisfies(version, '>=0.1.7-rc.1', { includePrerelease: true })
}

export function listLocalInternalNames(root = packageRoot) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  if (!existsSync(scope)) return []
  return readdirSync(scope).filter(name => name.startsWith('dsh-')).map(name => `@deepseek-ai/${name}`)
}

// The smoke install pins these ranges so a later prerelease cannot replace the
// host under test. Compatibility checks that reuse the tree must build it
// with the same pins.
export function buildPinnedOverrides({ version, hostDependencies = {}, localInternalNames = [] }) {
  const internalVersion = internalVersionFor(version)
  // Registry metadata and the published package.json list the same dependencies
  // in different key orders. Sort so the pin does not depend on that order.
  const names = [...new Set([
    ...Object.keys(hostDependencies),
    ...localInternalNames,
    ...LEGACY_TRANSITIVE_NAMES,
  ])].filter(name => name.startsWith('@deepseek-ai/dsh-')).sort()
  const overrides = Object.fromEntries(names.map(name => [name, internalVersion]))
  const modernHost = isModernHost(version)
  overrides['@deepseek-ai/cordis'] = modernHost ? hostDependencies['@deepseek-ai/cordis'] : '4.0.2'
  overrides['@deepseek-ai/schemastery'] = modernHost ? hostDependencies['@deepseek-ai/schemastery'] : '3.18.2'
  if (!modernHost) overrides['@deepseek-ai/cordis-plugin-loader'] = '1.0.3'
  return JSON.parse(JSON.stringify(overrides))
}

export function sameOverrideMap(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}

function cliPaths(root) {
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  return {
    manifest: join(packageDir, 'package.json'),
    bin: join(packageDir, 'lib', 'bin.js'),
  }
}

export function installedPackageVersions(nodeModules) {
  if (!existsSync(nodeModules)) return []
  const versions = []
  const consider = (directory) => {
    const manifest = readJson(join(directory, 'package.json'))
    if (manifest && typeof manifest.name === 'string' && typeof manifest.version === 'string') {
      versions.push(`${manifest.name}@${manifest.version}`)
    }
  }
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name.startsWith('.')) continue
    const path = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      let children = []
      try {
        children = readdirSync(path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (child.name.startsWith('.')) continue
        consider(join(path, child.name))
      }
      continue
    }
    consider(path)
  }
  versions.sort()
  return versions
}

export function treeFingerprint(nodeModules) {
  return createHash('sha256').update(installedPackageVersions(nodeModules).join('\n')).digest('hex')
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function validateIsolateTree(root, version, rootForLocalNames = packageRoot) {
  const fail = (reason) => ({ ok: false, reason })
  if (!root || !existsSync(root)) return fail('missing root')
  const sentinel = readJson(join(root, SENTINEL_NAME))
  if (!sentinel) return fail('missing sentinel')
  if (sentinel.complete !== true) return fail('incomplete sentinel')
  if (sentinel.version !== version) return fail(`sentinel version ${sentinel.version}`)
  const { manifest, bin } = cliPaths(root)
  const cli = readJson(manifest)
  if (!cli) return fail('missing CLI manifest')
  if (cli.version !== version) return fail(`CLI version ${cli.version}`)
  if (!existsSync(bin)) return fail('missing CLI bin')
  let binHash
  try {
    binHash = sha256File(bin)
  } catch {
    return fail('unreadable CLI bin')
  }
  if (binHash !== sentinel.cliBinSha256) return fail('CLI bin changed')
  const nodeModules = join(root, 'node_modules')
  const versions = installedPackageVersions(nodeModules)
  if (versions.length !== sentinel.packageCount) return fail('package count mismatch')
  if (treeFingerprint(nodeModules) !== sentinel.fingerprint) return fail('fingerprint mismatch')
  let overrides
  try {
    overrides = buildPinnedOverrides({
      version,
      hostDependencies: cli.dependencies ?? {},
      localInternalNames: listLocalInternalNames(rootForLocalNames),
    })
  } catch (error) {
    return fail(`overrides unavailable: ${error instanceof Error ? error.message : error}`)
  }
  if (!sameOverrideMap(overrides, sentinel.overrides)) return fail('override drift')
  return { ok: true, sentinel, fingerprint: sentinel.fingerprint }
}

function staysInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function assertSymlinksStayInside(root) {
  const expected = resolve(root)
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const current = stack.pop()
    let currentReal
    try {
      currentReal = realpathSync(current)
    } catch (error) {
      throw new Error(`unreadable isolate directory ${current}: ${error instanceof Error ? error.message : error}`)
    }
    if (!staysInside(expected, currentReal)) throw new Error(`directory escapes isolate copy: ${current}`)
    if (seen.has(currentReal)) continue
    seen.add(currentReal)
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      throw new Error(`unreadable isolate directory ${current}: ${error instanceof Error ? error.message : error}`)
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        let target
        try {
          target = realpathSync(path)
        } catch {
          throw new Error(`broken symlink in isolate copy: ${path}`)
        }
        if (!staysInside(expected, target)) throw new Error(`symlink escapes isolate copy: ${path}`)
        continue
      }
      if (entry.isDirectory()) stack.push(path)
    }
  }
}

export function copyIsolateTree(sourceRoot, destRoot) {
  const sentinel = join(sourceRoot, SENTINEL_NAME)
  if (!existsSync(sentinel)) throw new Error('isolated CLI sentinel is missing')
  const dest = join(destRoot, 'node_modules')
  wipe(dest)
  try {
    cpSync(join(sourceRoot, 'node_modules'), dest, { recursive: true, verbatimSymlinks: true })
    assertSymlinksStayInside(dest)
    cpSync(sentinel, join(destRoot, SENTINEL_NAME))
  } catch (error) {
    wipe(dest)
    rmSync(join(destRoot, SENTINEL_NAME), { force: true })
    throw error
  }
}

export function pinCopiedDependencies(packageJsonPath, nodeModules) {
  const manifest = readJson(packageJsonPath)
  if (!manifest) throw new Error(`package.json is missing: ${packageJsonPath}`)
  const dependencies = { ...(manifest.dependencies ?? {}) }
  const overrides = manifest.overrides
  for (const spec of installedPackageVersions(nodeModules)) {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    if (!name || name === 'stratagate-dsh' || !version) continue
    dependencies[name] = version
    // npm compares the override string with the direct dependency string. A
    // resolved 4.1.0 still conflicts with an override of ~4.1.0. Freeze both
    // to the installed version so the copy cannot float or raise EOVERRIDE.
    if (overrides && Object.hasOwn(overrides, name)) overrides[name] = version
  }
  manifest.dependencies = dependencies
  writeFileSync(packageJsonPath, JSON.stringify(manifest, null, 2))
  return dependencies
}

export function writeDependencySpecs(packageJsonPath, specs) {
  const manifest = readJson(packageJsonPath)
  if (!manifest) throw new Error(`package.json is missing: ${packageJsonPath}`)
  const dependencies = { ...(manifest.dependencies ?? {}) }
  for (const spec of specs) {
    if (!spec?.name || spec.version === undefined || spec.version === null || spec.version === '') {
      throw new Error(`invalid internal package spec: ${JSON.stringify(spec)}`)
    }
    dependencies[spec.name] = String(spec.version)
  }
  manifest.dependencies = dependencies
  writeFileSync(packageJsonPath, JSON.stringify(manifest, null, 2))
  return dependencies
}

export function internalPackageSpecs(hostModules) {
  const manifest = readJson(join(hostModules, '@deepseek-ai', 'dsh', 'package.json'))
  if (!manifest) throw new Error(`DSH host manifest is missing under ${hostModules}`)
  return Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/')).map(name => {
    const installed = readJson(join(hostModules, ...name.split('/'), 'package.json'))
    const version = installed?.version ?? manifest.dependencies[name]
    if (version === undefined || version === null || version === '') throw new Error(`missing version for ${name}`)
    return { name, version: String(version) }
  })
}

export function attachIsolatedCli(sourceRoot, destRoot, version, rootForLocalNames = packageRoot) {
  const check = validateIsolateTree(sourceRoot, version, rootForLocalNames)
  if (!check.ok) {
    const error = new Error(check.reason)
    error.code = 'ISOLATE_REJECTED'
    throw error
  }
  try {
    copyIsolateTree(sourceRoot, destRoot)
    const copied = validateIsolateTree(destRoot, version, rootForLocalNames)
    if (!copied.ok) throw new Error(copied.reason)
    const manifestPath = join(destRoot, 'package.json')
    const manifest = readJson(manifestPath)
    if (!manifest) throw new Error(`package.json is missing: ${manifestPath}`)
    manifest.overrides = copied.sentinel.overrides
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    return copied.sentinel
  } catch (error) {
    wipe(join(destRoot, 'node_modules'))
    rmSync(join(destRoot, SENTINEL_NAME), { force: true })
    throw error
  }
}

export function seedPackageInstallFromIsolate(sourceRoot, installRoot, version, rootForLocalNames = packageRoot) {
  const sentinel = attachIsolatedCli(sourceRoot, installRoot, version, rootForLocalNames)
  try {
    pinCopiedDependencies(join(installRoot, 'package.json'), join(installRoot, 'node_modules'))
  } catch (error) {
    wipe(join(installRoot, 'node_modules'))
    rmSync(join(installRoot, SENTINEL_NAME), { force: true })
    throw error
  }
  return sentinel
}

export function manifestFromNpmView(text, version) {
  const start = String(text).search(/[\[{]/)
  if (start < 0) throw new Error(`npm did not return JSON for ${version}: ${String(text).slice(0, 200)}`)
  const viewed = JSON.parse(String(text).slice(start))
  const manifest = Array.isArray(viewed) ? viewed.find(item => item.version === version) ?? viewed[0] : viewed
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`npm view returned no manifest for ${version}`)
  }
  return manifest
}

function defaultRun(args, cwd) {
  const result = spawnSync(npm, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`)
  return result.stdout ?? ''
}

function writeSentinel(root, version, overrides) {
  const nodeModules = join(root, 'node_modules')
  const versions = installedPackageVersions(nodeModules)
  const { bin } = cliPaths(root)
  const sentinel = {
    complete: true,
    version,
    overrides,
    fingerprint: treeFingerprint(nodeModules),
    packageCount: versions.length,
    cliBinSha256: sha256File(bin),
    installedAt: new Date().toISOString(),
  }
  writeFileSync(join(root, SENTINEL_NAME), JSON.stringify(sentinel, null, 2))
  return sentinel
}

export function installPinnedCli({ root, version, packageRoot: localRoot = packageRoot, run = defaultRun }) {
  mkdirSync(root, { recursive: true })
  run(['init', '--yes'], root)
  const hostManifest = manifestFromNpmView(run(['view', `@deepseek-ai/dsh@${version}`, '--json'], root), version)
  const localInternalNames = listLocalInternalNames(localRoot)
  const used = buildPinnedOverrides({
    version,
    hostDependencies: hostManifest.dependencies ?? {},
    localInternalNames,
  })
  const manifestPath = join(root, 'package.json')
  const manifest = readJson(manifestPath)
  if (!manifest) throw new Error(`npm init did not create ${manifestPath}`)
  manifest.overrides = used
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  run(['install', '--no-save', '--package-lock=false', `@deepseek-ai/dsh@${version}`], root)
  const cli = readJson(cliPaths(root).manifest)
  if (!cli || cli.version !== version) throw new Error(`DSH CLI ${version} was not installed`)
  if (!existsSync(cliPaths(root).bin)) throw new Error(`DSH CLI ${version} bin is missing`)
  const recorded = buildPinnedOverrides({
    version,
    hostDependencies: cli.dependencies ?? {},
    localInternalNames,
  })
  if (!sameOverrideMap(used, recorded)) {
    throw new Error(`Installed DSH ${version} dependencies do not reproduce the overrides used to install it`)
  }
  const sentinel = writeSentinel(root, version, recorded)
  const check = validateIsolateTree(root, version, localRoot)
  if (!check.ok) throw new Error(`fresh DSH isolate failed validation: ${check.reason}`)
  return sentinel
}

export function ensureIsolateCli({ root, version, packageRoot: localRoot = packageRoot, run = defaultRun }) {
  const started = Date.now()
  const current = validateIsolateTree(root, version, localRoot)
  if (current.ok) {
    console.log(`[dsh-isolate] reuse ${version} packages=${current.sentinel.packageCount} seconds=${secondsSince(started)}`)
    return { reused: true, sentinel: current.sentinel }
  }
  const hadSentinel = existsSync(join(root, SENTINEL_NAME))
  const populated = hadSentinel || existsSync(join(root, 'node_modules'))
  if (populated) {
    console.log(`[dsh-isolate] reject ${version}: ${current.reason}; rebuilding`)
    if (hadSentinel) {
      console.log('[dsh-isolate] A saved cache for this key cannot be overwritten. The next run restores it and rebuilds until the isolate script changes.')
    }
  } else {
    console.log(`[dsh-isolate] install ${version}: ${current.reason}`)
  }
  if (existsSync(root)) wipe(root)
  const sentinel = installPinnedCli({ root, version, packageRoot: localRoot, run })
  console.log(`[dsh-isolate] installed ${version} packages=${sentinel.packageCount} seconds=${secondsSince(started)}`)
  return { reused: false, sentinel }
}

function main() {
  const version = process.env.DSH_VERSION
  const root = process.env.DSH_ISOLATE_ROOT
  if (!version || !root) throw new Error('DSH_VERSION and DSH_ISOLATE_ROOT are required')
  const result = ensureIsolateCli({ root, version, packageRoot })
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `cache_save=${result.reused ? 'false' : 'true'}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
