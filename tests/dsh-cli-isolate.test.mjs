import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attachIsolatedCli,
  buildPinnedOverrides,
  ensureIsolateCli,
  internalPackageSpecs,
  manifestFromNpmView,
  pinCopiedDependencies,
  seedPackageInstallFromIsolate,
  validateIsolateTree,
  writeDependencySpecs,
} from '../scripts/dsh-cli-isolate.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.2.2-rc.1'
const dependencies = {
  '@deepseek-ai/cordis': '~4.1.0',
  '@deepseek-ai/schemastery': '~3.19.0',
  '@deepseek-ai/dsh-session': version,
}

function fakeNpm(installs) {
  return (args, cwd) => {
    if (args[0] === 'init') {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'isolate', version: '1.0.0' }))
      return '{}'
    }
    if (args[0] === 'view') return JSON.stringify({ version, dependencies })
    if (args[0] === 'install') {
      installs.count += 1
      const scope = join(cwd, 'node_modules', '@deepseek-ai')
      mkdirSync(join(scope, 'dsh', 'lib'), { recursive: true })
      writeFileSync(join(scope, 'dsh', 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh', version, dependencies,
      }))
      writeFileSync(join(scope, 'dsh', 'lib', 'bin.js'), 'process.stdout.write("dsh")\n')
      mkdirSync(join(scope, 'dsh-session'), { recursive: true })
      writeFileSync(join(scope, 'dsh-session', 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-session', version,
      }))
      mkdirSync(join(cwd, 'node_modules', 'left-pad'), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0' }))
      return ''
    }
    throw new Error(`unexpected npm ${args.join(' ')}`)
  }
}

test('npm view text can carry a log prefix or a version list', () => {
  const manifest = manifestFromNpmView(`npm notice\n[{"version":"0.1.2-rc.1","dependencies":{"@deepseek-ai/cordis":"4.0.2"}},{"version":"${version}","dependencies":{"@deepseek-ai/cordis":"~4.1.0"}}]`, version)
  assert.equal(manifest.dependencies['@deepseek-ai/cordis'], '~4.1.0')
  assert.throws(() => manifestFromNpmView('no json', version), /did not return JSON/)
})

test('legacy hosts keep Cordis 4.0.2 and modern hosts keep the CLI range', () => {
  const hostDependencies = {
    '@deepseek-ai/cordis': '~4.0.4',
    '@deepseek-ai/schemastery': '~3.18.4',
    '@deepseek-ai/dsh-session': '0.1.2-rc.1',
  }
  for (const host of ['0.1.2-rc.1', '0.1.5-rc.1', '0.1.6-alpha.1']) {
    const overrides = buildPinnedOverrides({
      version: host,
      hostDependencies,
      localInternalNames: ['@deepseek-ai/dsh-tools'],
    })
    const pinned = host === '0.1.5-rc.1' ? '0.1.5-rc.2' : host
    assert.equal(overrides['@deepseek-ai/cordis'], '4.0.2', host)
    assert.equal(overrides['@deepseek-ai/schemastery'], '3.18.2', host)
    assert.equal(overrides['@deepseek-ai/cordis-plugin-loader'], '1.0.3', host)
    assert.equal(overrides['@deepseek-ai/dsh-session'], pinned, host)
    assert.equal(overrides['@deepseek-ai/dsh-tools'], pinned, host)
    assert.equal(overrides['@deepseek-ai/dsh-agent-presets'], pinned, host)
    assert.equal(overrides['@deepseek-ai/dsh-settings-file'], pinned, host)
  }
  for (const host of ['0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.2-rc.1']) {
    const overrides = buildPinnedOverrides({ version: host, hostDependencies, localInternalNames: [] })
    assert.equal(overrides['@deepseek-ai/cordis'], '~4.0.4', host)
    assert.equal(overrides['@deepseek-ai/schemastery'], '~3.18.4', host)
    assert.equal(overrides['@deepseek-ai/cordis-plugin-loader'], undefined, host)
  }
})

test('a valid isolate is reused and a dirty tree is rebuilt', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-isolate-'))
  const installs = { count: 0 }
  const run = fakeNpm(installs)
  try {
    const first = ensureIsolateCli({ root, version, packageRoot: repo, run })
    assert.equal(first.reused, false)
    assert.equal(installs.count, 1)
    assert.equal(validateIsolateTree(root, version, repo).ok, true)
    assert.equal(validateIsolateTree(root, '0.1.2-rc.1', repo).ok, false)
    const second = ensureIsolateCli({ root, version, packageRoot: repo, run })
    assert.equal(second.reused, true)
    assert.equal(installs.count, 1)

    const session = join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')
    writeFileSync(session, JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.0.0-dirty' }))
    assert.equal(validateIsolateTree(root, version, repo).ok, false)
    const third = ensureIsolateCli({ root, version, packageRoot: repo, run })
    assert.equal(third.reused, false)
    assert.equal(installs.count, 2)
    assert.equal(JSON.parse(readFileSync(session, 'utf8')).version, version)

    rmSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    assert.equal(validateIsolateTree(root, version, repo).reason, 'missing CLI bin')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('internal specs prefer the installed version and keep a declared range', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-isolate-specs-'))
  const installs = { count: 0 }
  try {
    ensureIsolateCli({ root, version, packageRoot: repo, run: fakeNpm(installs) })
    const specs = internalPackageSpecs(join(root, 'node_modules'))
    assert.equal(specs.find(spec => spec.name === '@deepseek-ai/dsh-session').version, version)
    assert.equal(specs.find(spec => spec.name === '@deepseek-ai/cordis').version, '~4.1.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a copied CLI stays inside its directory and does not alias the cache', () => {
  const source = mkdtempSync(join(tmpdir(), 'dsh-isolate-src-'))
  const dest = mkdtempSync(join(tmpdir(), 'dsh-isolate-dest-'))
  const installs = { count: 0 }
  try {
    ensureIsolateCli({ root: source, version, packageRoot: repo, run: fakeNpm(installs) })
    symlinkSync('../dsh/package.json', join(source, 'node_modules', '@deepseek-ai', 'dsh-session', 'alias.json'))
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'smoke', version: '1.0.0' }))
    const sentinel = attachIsolatedCli(source, dest, version, repo)
    assert.equal(sentinel.version, version)
    assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).overrides['@deepseek-ai/cordis'], '~4.1.0')
    const copied = readFileSync(join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    writeFileSync(join(source, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }))
    assert.equal(readFileSync(join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'), copied)
    assert.equal(validateIsolateTree(dest, version, repo).ok, true)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})

test('a symlink that leaves the isolate copy is rejected and removed', () => {
  const source = mkdtempSync(join(tmpdir(), 'dsh-isolate-escape-'))
  const dest = mkdtempSync(join(tmpdir(), 'dsh-isolate-escape-dest-'))
  const outside = join(tmpdir(), `dsh-isolate-outside-${process.pid}`)
  const installs = { count: 0 }
  try {
    ensureIsolateCli({ root: source, version, packageRoot: repo, run: fakeNpm(installs) })
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(source, 'node_modules', 'escaped'))
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'smoke', version: '1.0.0' }))
    assert.throws(() => attachIsolatedCli(source, dest, version, repo), /escapes isolate copy/)
    assert.equal(existsSync(join(dest, 'node_modules')), false)
    assert.equal(existsSync(join(dest, '.stratagate-dsh-isolate.json')), false)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(outside, { force: true })
  }
})

test('package verification reuses the isolate instead of installing each internal package', () => {
  const source = readFileSync(join(repo, 'scripts', 'verify-package.mjs'), 'utf8')
  assert.match(source, /writeDependencySpecs/)
  assert.equal(source.includes('for (const name of dshPackages)'), false)

  const isolate = mkdtempSync(join(tmpdir(), 'dsh-isolate-verify-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-isolate-verify-work-'))
  const installs = { count: 0 }
  try {
    ensureIsolateCli({ root: isolate, version, packageRoot: repo, run: fakeNpm(installs) })
    const pack = join(work, 'package')
    mkdirSync(pack, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    const paths = ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'docs/DSH.md', 'docs/DSH.zh-CN.md', 'screenshots.json', 'CHANGELOG.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/plugin.js', 'dist/repair-profile.js', 'dist/client.js', 'dist/client.d.ts']
    for (const file of paths) {
      const path = join(pack, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file === 'package.json' ? JSON.stringify(manifest) : '')
    }
    const tarball = join(work, 'candidate.tgz')
    assert.equal(spawnSync('tar', ['-czf', tarball, '-C', work, 'package']).status, 0)
    const log = join(work, 'npm-log.txt')
    const npmMock = join(work, 'npm-mock.cjs')
    writeFileSync(npmMock, `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawnSync } = require('node:child_process');
      const log = process.env.NPM_MOCK_LOG;
      const args = process.argv.slice(2);
      fs.appendFileSync(log, JSON.stringify(args) + '\\n');
      if (args[0] === 'init') {
        const dest = path.join(process.cwd(), 'package.json');
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, JSON.stringify({ name: 'pack-check', version: '1.0.0' }));
        process.exit(0);
      }
      if (args[0] === 'install') {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        fs.appendFileSync(log, 'DEPS ' + Object.keys(pkg.dependencies || {}).sort().join(',') + '\\n');
        const spec = args[1];
        if (spec && spec.endsWith('.tgz')) {
          const dest = path.join(process.cwd(), 'node_modules', 'stratagate-dsh');
          fs.mkdirSync(dest, { recursive: true });
          const extracted = spawnSync('tar', ['-xzf', spec, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
          process.exit(extracted.status ?? 1);
        }
        process.exit(0);
      }
      process.exit(0);
    `)
    const result = spawnSync(process.execPath, [join(repo, 'scripts', 'verify-package.mjs'), tarball], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: npmMock, NPM_MOCK_LOG: log, DSH_VERSION: version, DSH_ROOT: isolate },
    })
    assert.equal(result.status, 0, result.stderr)
    const calls = readFileSync(log, 'utf8')
    assert.match(calls, /reused isolated CLI|DEPS /)
    assert.match(result.stdout, /reused isolated CLI 0\.2\.2-rc\.1/)
    assert.equal(calls.includes(`"@deepseek-ai/dsh@${version}"`), false)
    assert.match(calls, /DEPS [^\n]*@deepseek-ai\/dsh[^\n]*left-pad/)
    assert.equal([...calls.matchAll(/"install"/g)].length, 1)
  } finally {
    rmSync(isolate, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('pinned copied packages survive a later tarball install', () => {
  const src = mkdtempSync(join(tmpdir(), 'dsh-pin-src-'))
  const dest = mkdtempSync(join(tmpdir(), 'dsh-pin-dest-'))
  try {
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'src', version: '1.0.0' }))
    const installed = spawnSync('npm', ['install', 'ms@2.1.3', 'semver@7.6.0', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'], {
      cwd: src, encoding: 'utf8',
    })
    assert.equal(installed.status, 0, installed.stderr)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'dest', version: '1.0.0' }))
    spawnSync('cp', ['-a', join(src, 'node_modules'), join(dest, 'node_modules')], { encoding: 'utf8' })
    const pinned = pinCopiedDependencies(join(dest, 'package.json'), join(dest, 'node_modules'))
    assert.equal(pinned.ms, '2.1.3')
    assert.equal(pinned.semver, '7.6.0')
    const pack = mkdtempSync(join(tmpdir(), 'dsh-pin-pack-'))
    mkdirSync(join(pack, 'package'), { recursive: true })
    writeFileSync(join(pack, 'package', 'package.json'), JSON.stringify({ name: 'tiny-verify', version: '1.0.0' }))
    writeFileSync(join(pack, 'package', 'index.js'), 'module.exports = 1\n')
    const tarball = join(dest, 'tiny.tgz')
    assert.equal(spawnSync('tar', ['-czf', tarball, '-C', pack, 'package']).status, 0)
    const added = spawnSync('npm', ['install', tarball, '--ignore-scripts', '--package-lock=false', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
      cwd: dest, encoding: 'utf8',
    })
    assert.equal(added.status, 0, added.stderr)
    assert.equal(JSON.parse(readFileSync(join(dest, 'node_modules', 'ms', 'package.json'), 'utf8')).version, '2.1.3')
    assert.equal(JSON.parse(readFileSync(join(dest, 'node_modules', 'semver', 'package.json'), 'utf8')).version, '7.6.0')
    assert.equal(JSON.parse(readFileSync(join(dest, 'node_modules', 'tiny-verify', 'package.json'), 'utf8')).version, '1.0.0')
    rmSync(pack, { recursive: true, force: true })
  } finally {
    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})

test('one dependency list is written for a fallback install', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-specs-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fallback', version: '1.0.0', dependencies: { kept: '1.0.0' } }))
    const written = writeDependencySpecs(join(root, 'package.json'), [
      { name: '@deepseek-ai/dsh', version },
      { name: '@deepseek-ai/dsh-session', version },
    ])
    assert.equal(written.kept, '1.0.0')
    assert.equal(written['@deepseek-ai/dsh'], version)
    assert.equal(written['@deepseek-ai/dsh-session'], version)
    assert.throws(() => writeDependencySpecs(join(root, 'package.json'), [{ name: 'bad' }]), /invalid internal package spec/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a restored isolate reports that the cache does not need saving', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-isolate-main-'))
  const output = join(root, 'github-output.txt')
  const installs = { count: 0 }
  try {
    ensureIsolateCli({ root, version, packageRoot: repo, run: fakeNpm(installs) })
    const result = spawnSync(process.execPath, [join(repo, 'scripts', 'dsh-cli-isolate.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, DSH_VERSION: version, DSH_ISOLATE_ROOT: root, GITHUB_OUTPUT: output },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\[dsh-isolate\] reuse 0\.2\.2-rc\.1/)
    assert.equal(readFileSync(output, 'utf8').includes('cache_save=false'), true)
    assert.equal(installs.count, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function installWithDependencyOrder(root, viewDependencies, installedDependencies) {
  const run = (args, cwd) => {
    if (args[0] === 'init') {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'isolate', version: '1.0.0' }))
      return '{}'
    }
    if (args[0] === 'view') return JSON.stringify({ version, dependencies: viewDependencies })
    if (args[0] === 'install') {
      const scope = join(cwd, 'node_modules', '@deepseek-ai')
      mkdirSync(join(scope, 'dsh', 'lib'), { recursive: true })
      writeFileSync(join(scope, 'dsh', 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh', version, dependencies: installedDependencies,
      }))
      writeFileSync(join(scope, 'dsh', 'lib', 'bin.js'), 'process.stdout.write("dsh")\n')
      for (const [name, spec] of Object.entries(installedDependencies)) {
        if (typeof spec !== 'string' || spec.startsWith('~') || spec.startsWith('^')) continue
        const folder = join(cwd, 'node_modules', ...name.split('/'))
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, version: spec }))
      }
      return ''
    }
    throw new Error(`unexpected npm ${args.join(' ')}`)
  }
  return ensureIsolateCli({ root, version, packageRoot: repo, run })
}

test('same dependency values in a different key order are accepted', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-order-'))
  const viewDependencies = {
    '@deepseek-ai/dsh-base': version,
    '@deepseek-ai/dsh-acp-app': version,
    '@deepseek-ai/cordis': '~4.1.0',
    '@deepseek-ai/schemastery': '~3.19.0',
  }
  const installedDependencies = {
    '@deepseek-ai/dsh-acp-app': version,
    '@deepseek-ai/schemastery': '~3.19.0',
    '@deepseek-ai/cordis': '~4.1.0',
    '@deepseek-ai/dsh-base': version,
  }
  try {
    const result = installWithDependencyOrder(root, viewDependencies, installedDependencies)
    assert.equal(result.reused, false)
    assert.equal(validateIsolateTree(root, version, repo).ok, true)
    const sentinel = JSON.parse(readFileSync(join(root, '.stratagate-dsh-isolate.json'), 'utf8'))
    const reordered = {}
    for (const key of Object.keys(sentinel.overrides).reverse()) reordered[key] = sentinel.overrides[key]
    sentinel.overrides = reordered
    writeFileSync(join(root, '.stratagate-dsh-isolate.json'), JSON.stringify(sentinel))
    assert.equal(validateIsolateTree(root, version, repo).ok, true)
    sentinel.overrides['@deepseek-ai/cordis'] = '~4.9.0'
    writeFileSync(join(root, '.stratagate-dsh-isolate.json'), JSON.stringify(sentinel))
    assert.equal(validateIsolateTree(root, version, repo).reason, 'override drift')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a real dependency value change is still rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-drift-'))
  const viewDependencies = {
    '@deepseek-ai/dsh-base': version,
    '@deepseek-ai/cordis': '~4.1.0',
    '@deepseek-ai/schemastery': '~3.19.0',
  }
  const installedDependencies = {
    '@deepseek-ai/cordis': '~4.9.0',
    '@deepseek-ai/dsh-base': version,
    '@deepseek-ai/schemastery': '~3.19.0',
  }
  try {
    assert.throws(
      () => installWithDependencyOrder(root, viewDependencies, installedDependencies),
      /dependencies do not reproduce the overrides used to install it/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('copied exact versions match override strings and npm can install them', () => {
  const cases = [
    {
      label: '0.1.2-rc.1',
      packages: { '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/schemastery': '3.18.2' },
      overrides: { '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/schemastery': '3.18.2' },
    },
    {
      label: '0.1.7-rc.2',
      packages: { '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/schemastery': '3.18.5' },
      overrides: { '@deepseek-ai/cordis': '~4.0.4', '@deepseek-ai/schemastery': '~3.18.4' },
    },
    {
      label: '0.2.2-rc.1',
      packages: { '@deepseek-ai/cordis': '4.1.0', '@deepseek-ai/schemastery': '3.19.0' },
      overrides: { '@deepseek-ai/cordis': '~4.1.0', '@deepseek-ai/schemastery': '~3.19.0' },
    },
  ]
  for (const { label, packages, overrides } of cases) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pin-npm-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pin-probe', version: '1.0.0', overrides }, null, 2))
      for (const [name, spec] of Object.entries(packages)) {
        const folder = join(root, 'node_modules', ...name.split('/'))
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, version: spec }))
      }
      pinCopiedDependencies(join(root, 'package.json'), join(root, 'node_modules'))
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      for (const [name, spec] of Object.entries(packages)) {
        assert.equal(manifest.dependencies[name], spec, `${label} ${name} dependency`)
        assert.equal(manifest.overrides[name], spec, `${label} ${name} override`)
      }
      rmSync(join(root, 'node_modules'), { recursive: true, force: true })
      const installed = spawnSync('npm', ['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'], {
        cwd: root, encoding: 'utf8',
      })
      assert.equal(installed.status, 0, `${label}\n${installed.stderr}`)
      for (const [name, spec] of Object.entries(packages)) {
        const actual = JSON.parse(readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
        assert.equal(actual, spec, `${label} installed ${name}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('package seeding pins the copied tree for the tarball install', () => {
  const source = mkdtempSync(join(tmpdir(), 'dsh-seed-src-'))
  const dest = mkdtempSync(join(tmpdir(), 'dsh-seed-dest-'))
  const installs = { count: 0 }
  try {
    ensureIsolateCli({ root: source, version, packageRoot: repo, run: fakeNpm(installs) })
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'verify', version: '1.0.0' }))
    seedPackageInstallFromIsolate(source, dest, version, repo)
    const manifest = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['@deepseek-ai/dsh'], version)
    assert.equal(manifest.dependencies['left-pad'], '1.3.0')
    assert.equal(manifest.overrides['@deepseek-ai/dsh-session'], version)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})
