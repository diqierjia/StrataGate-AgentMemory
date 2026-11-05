import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { satisfies } from 'semver'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const expectedPluginVersion = process.env.EXPECTED_PLUGIN_VERSION ?? manifest.version
const tarball = process.argv[2] ? resolve(packageRoot, process.argv[2]) : join(packageRoot, `${manifest.name}-${manifest.version}.tgz`)
const versions = process.env.DSH_VERSION
  ? [process.env.DSH_VERSION]
  : manifest.dshWorkshop.compatibility.dshVersions
const fixtureRoot = join(packageRoot, 'tests', 'fixtures')

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: process.platform === 'win32' && command === npm,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function platformFixture(source) {
  const cwd = process.platform === 'win32' ? 'C:\\redacted\\workspace' : '/redacted/workspace'
  return source.replace(/("cwd":)"[^"]*"/, `$1${JSON.stringify(cwd)}`)
}

function seedSessions(dshHome) {
  const projectId = process.platform === 'win32' ? '--C-redacted-workspace--' : '--redacted-workspace--'
  const project = join(dshHome, 'sessions', projectId)
  const fixtures = [
    ['legacy-session-v0', 'fixture-legacy-citations'],
    ['clean-session-v0', 'fixture-clean-session'],
  ]
  for (const [fixture, id] of fixtures) {
    const directory = join(project, id)
    mkdirSync(directory, { recursive: true })
    const source = readFileSync(join(fixtureRoot, fixture, 'session.jsonl'), 'utf8')
    writeFileSync(join(directory, 'session.jsonl'), platformFixture(source))
  }
}

async function smokeWeb(cli, root, env, version, sidebarCheck) {
  const output = []
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--port', '0', '--no-open'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let timer
  try {
    const launchUrl = await new Promise((resolveReady, rejectReady) => {
      const inspect = (chunk) => {
        const text = chunk.toString()
        output.push(text)
        const match = output.join('').match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[A-Za-z0-9_-]+/)
        if (match) resolveReady(match[0])
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('exit', (code) => rejectReady(new Error(`${version}: Web smoke exited ${code}\n${output.join('')}`)))
      // A cold 0.1.5 profile can spend close to a minute materializing its
      // generated browser graph on Windows CI before it prints the launch URL.
      timer = setTimeout(() => rejectReady(new Error(`${version}: Web smoke timed out\n${output.join('')}`)), 120_000)
    })
    const origin = new URL(launchUrl).origin
    // The CLI prints the launch URL just before the listener can accept
    // connections. Retry only this startup race, with a firm time limit.
    let exchange
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        exchange = await fetch(launchUrl, { redirect: 'manual' })
        break
      } catch (error) {
        if (child.exitCode !== null || attempt === 39) {
          throw new Error(`${version}: Web launch URL never became reachable\n${output.join('')}`, { cause: error })
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    assert(exchange.status === 303, `${version}: launch-token exchange returned HTTP ${exchange.status}`)
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    assert(cookie, `${version}: launch-token exchange did not mint a browser cookie`)
    const response = await fetch(origin, { headers: { cookie } })
    assert(response.ok, `${version}: Web shell returned HTTP ${response.status}`)
    const html = await response.text()
    assert(html.includes('__DSH_BOOT__'), `${version}: Web shell omitted the DSH boot payload`)

    const overviewResponse = await fetch(`${origin}/api/stratagate/overview`, { headers: { cookie } })
    assert(overviewResponse.status === 200, `${version}: StrataGate admin probe returned HTTP ${overviewResponse.status}\n${output.join('').replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')}`)
    const overview = await overviewResponse.json()
    assert(overview?.readonly === true, `${version}: StrataGate admin probe omitted its read-only contract`)
    const checkedPluginVersion = sidebarCheck?.pluginVersion ?? expectedPluginVersion
    assert(overview?.pluginVersion === checkedPluginVersion, `${version}: StrataGate admin probe reported plugin ${overview?.pluginVersion ?? '<missing>'}`)
    assert(Array.isArray(overview?.namespaces), `${version}: StrataGate admin probe omitted namespaces`)

    const call = async (method, args) => {
      const rpcId = randomUUID()
      const rpcResponse = await fetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      })
      assert(rpcResponse.ok, `${version}: ${method} returned HTTP ${rpcResponse.status}`)
      const envelope = await rpcResponse.json()
      assert(envelope.rpcId === rpcId, `${version}: ${method} returned a mismatched RPC id`)
      assert(envelope.result?.ok === true, `${version}: ${method} failed: ${JSON.stringify(envelope.result?.error)}\n${output.join('').replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')}`)
      return envelope.result.value
    }

    if (sidebarCheck) {
      const settings = await call('settings/describe', {})
      const section = settings.namespaces.find(section => section.ns === 'stratagate-memory')
      assert(settings.writable && section, `${version}: writable StrataGate settings were not exposed`)
      assert(section.value.showSidebarEntry === sidebarCheck.expected, `${version}: sidebar preference did not survive restart: ${section.value.showSidebarEntry}`)
      if (sidebarCheck.write !== undefined) {
        const saved = await call('settings/mutate', {
          ns: section.ns,
          ops: [{ op: 'set', path: ['showSidebarEntry'], value: sidebarCheck.write }],
          expectedRevision: section.revision,
        })
        assert(saved.value.showSidebarEntry === sidebarCheck.write, `${version}: sidebar preference write was not applied`)
        const probe = await fetch(`${origin}/api/stratagate/overview`, { headers: { cookie } })
        assert(probe.ok && (await probe.json()).pluginVersion === checkedPluginVersion, `${version}: sidebar preference write disabled the memory service`)
      }
      console.log(`Verified sidebar setting on DSH ${version}: loaded ${sidebarCheck.expected}, saved ${sidebarCheck.write ?? 'unchanged'}, memory service available.`)
    }

    const listed = await call('session/list', { _request: {} })
    const expected = [
      ['fixture-legacy-citations', 13, 'Legacy citation fixture', 'Redacted assistant reply B'],
      ['fixture-clean-session', 6, 'Clean fixture session', 'Clean session assistant reply'],
    ]
    for (const [sessionId, throughSeq, title, reply] of expected) {
      const summary = listed.items.find(item => item.sessionId === sessionId)
      assert(summary, `${version}: session/list omitted ${sessionId}`)
      const projectedTitle = summary.projections?.values?.title
      if (projectedTitle !== undefined) {
        assert(projectedTitle === title, `${version}: ${sessionId} cached title projection was incorrect`)
      }
      const page = await call('session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 50 },
      })
      const records = JSON.stringify(page.records)
      // Cold profiles may omit optional projection hints and message-aligned
      // pages intentionally exclude log-only title events. The fixture source
      // is the durable title authority; when the Host exposes a hint, verify
      // its exact value as well.
      assert(projectedTitle === undefined || projectedTitle === title, `${version}: ${sessionId} cached title projection was incorrect`)
      const fixtureTitle = readFileSync(join(fixtureRoot, sessionId === 'fixture-legacy-citations' ? 'legacy-session-v0' : 'clean-session-v0', 'session.jsonl'), 'utf8')
      assert(fixtureTitle.includes(`\"title\":\"${title}\"`), `${version}: ${sessionId} fixture title was not retained`)
      assert(records.includes(reply), `${version}: switching to ${sessionId} did not return its conversation body`)
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5_000))])
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
}

async function verifyPluginFailureIsDetected(cli, root, env, version, profile) {
  const rootPath = realpathSync(root)
  const patch = realpathSync(join(profile, 'cordis.patch.yml'))
  assert(patch.startsWith(`${rootPath}${sep}`), `${version}: refusing to modify a profile patch outside the disposable smoke root: ${patch}`)
  const original = readFileSync(patch)
  writeFileSync(patch, [
    '- id: stratagate-memory',
    '  name: stratagate-dsh',
    '  inject: [stratagate-intentional-missing-service]',
    '',
    original.toString(),
  ].join('\n'))
  try {
    let failure
    try {
      await smokeWeb(cli, root, env, `${version} intentional-plugin-failure`)
    } catch (error) {
      failure = error
    }
    assert(failure, `${version}: smoke test passed even though StrataGate was intentionally broken`)
    const message = failure instanceof Error ? failure.message : String(failure)
    assert(
      message.includes('StrataGate admin probe returned HTTP 404'),
      `${version}: intentional plugin activation failure did not prove that the Web Host stayed up while the StrataGate probe failed:\n${message}`,
    )
  } finally {
    writeFileSync(patch, original)
  }
}

assert(existsSync(tarball), `Tarball does not exist: ${tarball}`)
const roots = []
try {
  for (const version of versions) {
    const root = mkdtempSync(join(tmpdir(), `stratagate-dsh-${version.replaceAll('.', '_')}-`))
    roots.push(root)
    const dshHome = join(root, 'dsh-home')
    seedSessions(dshHome)
    run(npm, ['init', '--yes'], root)
    // The prerelease CLI uses caret ranges. Pin its complete internal tree to
    // the version StrataGate actually supports, so a later rc cannot silently
    // change the host under this compatibility check.
    const hostManifest = JSON.parse(run(npm, ['view', `@deepseek-ai/dsh@${version}`, '--json'], root))
    const internalVersion = version === '0.1.5-rc.1' ? '0.1.5-rc.2' : version
    const localInternalNames = readdirSync(join(packageRoot, 'node_modules', '@deepseek-ai'))
      .filter(name => name.startsWith('dsh-'))
      .map(name => `@deepseek-ai/${name}`)
    // These transitive 0.1.6 packages are absent from the current CLI's
    // direct dependency list. Letting caret ranges choose alpha.2 withdraws
    // the older Host's strict typert definitions, including session/list.
    const legacyTransitiveNames = ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-settings-file']
    const overrides = Object.fromEntries([...new Set([...Object.keys(hostManifest.dependencies ?? {}), ...localInternalNames, ...legacyTransitiveNames])]
      .filter(name => name.startsWith('@deepseek-ai/dsh-'))
      .map(name => [name, internalVersion]))
    const modernHost = satisfies(version, '>=0.1.7-rc.1', { includePrerelease: true })
    overrides['@deepseek-ai/cordis'] = modernHost ? hostManifest.dependencies['@deepseek-ai/cordis'] : '4.0.2'
    overrides['@deepseek-ai/schemastery'] = modernHost ? hostManifest.dependencies['@deepseek-ai/schemastery'] : '3.18.2'
    const freshManifestPath = join(root, 'package.json')
    const freshManifest = JSON.parse(readFileSync(freshManifestPath, 'utf8'))
    freshManifest.overrides = overrides
    writeFileSync(freshManifestPath, JSON.stringify(freshManifest, null, 2))
    run(npm, ['install', '--no-save', '--package-lock=false', `@deepseek-ai/dsh@${version}`], root)
    const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    assert(existsSync(cli), `DSH CLI ${version} was not installed`)

    const dshEnv = { DSH_HOME: dshHome }
    run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tarball], root, dshEnv)
    const profile = join(dshHome, 'profiles', 'web')
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- id: session-persistence-jsonl',
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      "    root: !!js dshHomePath('sessions')",
      '    compression: none',
      '',
    ].join('\n'))
    const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert(Object.keys(profileManifest.dependencies ?? {}).join(',') === 'stratagate-dsh', `${version}: plugin dependency set was not isolated`)
    assert(!existsSync(join(profile, 'node_modules', '@deepseek-ai')), `${version}: fresh install leaked DSH core packages into the profile`)

    // Seed the exact failure shape reported by users. Pnpm intentionally does
    // not delete unknown hoisted directories, so the package must ignore this
    // stale peer without deleting user files or loading a second DSH runtime.
    const staleVersion = version === '0.1.5-rc.1' ? '0.1.2-rc.1' : '0.1.5-rc.2'
    const stalePackages = [
      ['@deepseek-ai/dsh-session', staleVersion],
      ['@deepseek-ai/dsh-native-command', staleVersion],
    ]
    for (const [name, stalePackageVersion] of stalePackages) {
      const stale = join(profile, 'node_modules', ...name.split('/'))
      mkdirSync(stale, { recursive: true })
      writeFileSync(join(stale, 'package.json'), JSON.stringify({ name, version: stalePackageVersion }))
    }

    // A second add exercises an in-place upgrade with the existing lockfile and
    // profile generation. The stale directory remains recoverable on disk, but
    // the bootstrap resolver must force StrataGate onto the host-owned tree.
    run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tarball], root, dshEnv)
    for (const [name] of stalePackages) {
      assert(existsSync(join(profile, 'node_modules', ...name.split('/'))), `${version}: upgrade unexpectedly deleted the seeded legacy package ${name}`)
    }
    // The clean CLI web templates can enable live user-patch watching without
    // mounting HMR. This smoke starts a fresh process for every patch check,
    // so startup loading exercises the installed plugin without that host bug.
    const manifestPath = join(profile, 'package.json')
    const installedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    installedManifest.dsh.profile.patchReload = 'startup'
    writeFileSync(manifestPath, JSON.stringify(installedManifest, null, 2))
    const repair = run(process.execPath, [cli, 'plugin', '--profile', 'web', 'exec', 'stratagate-dsh-repair'], root, dshEnv)
    assert(repair.includes('Quarantined'), `${version}: profile repair did not report a quarantine`)
    for (const [name] of stalePackages) {
      assert(!existsSync(join(profile, 'node_modules', ...name.split('/'))), `${version}: profile repair left the stale DSH package active: ${name}`)
    }
    const backups = join(profile, '.stratagate-runtime-backups')
    assert(existsSync(backups), `${version}: profile repair did not create a recoverable backup`)

    const config = run(process.execPath, [cli, '--profile', 'web', '--dump-config'], root, dshEnv)
    assert(config.includes("sessionRoot: !!js dshHomePath('sessions')"), `${version}: sessionRoot was not wired to the host DSH_HOME`)
    const verifySidebar = process.env.STRATAGATE_VERIFY_SIDEBAR === '1'
    await smokeWeb(cli, root, dshEnv, version, verifySidebar ? { expected: false, write: true } : undefined)
    if (verifySidebar) {
      await smokeWeb(cli, root, dshEnv, version, { expected: true, write: false })
      await smokeWeb(cli, root, dshEnv, version, { expected: false })
      if (process.env.STRATAGATE_VERIFY_SIDEBAR_BASELINE) {
        const baseline = resolve(packageRoot, process.env.STRATAGATE_VERIFY_SIDEBAR_BASELINE)
        assert(existsSync(baseline), `Sidebar upgrade baseline does not exist: ${baseline}`)
        run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', baseline], root, dshEnv)
        await smokeWeb(cli, root, dshEnv, version, { expected: false, write: true, pluginVersion: process.env.STRATAGATE_VERIFY_SIDEBAR_BASELINE_VERSION })
        run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tarball], root, dshEnv)
        await smokeWeb(cli, root, dshEnv, version, { expected: true, write: false })
        await smokeWeb(cli, root, dshEnv, version, { expected: false })
        console.log(`Verified sidebar upgrade to ${expectedPluginVersion}: saved on/off choices preserved.`)
      }
    }
    if (version === '0.1.6-alpha.1' || modernHost) {
      await verifyPluginFailureIsDetected(cli, root, dshEnv, version, profile)
    }
    const projectId = process.platform === 'win32' ? '--C-redacted-workspace--' : '--redacted-workspace--'
    const legacyDirectory = join(dshHome, 'sessions', projectId, 'fixture-legacy-citations')
    assert(existsSync(join(legacyDirectory, 'session.jsonl')), `${version}: immutable v0 fixture was removed`)
    if (version !== '0.1.2-rc.1') {
      assert(existsSync(join(legacyDirectory, 'session.v1.jsonl')), `${version}: legacy citation bridge was not published`)
      assert(existsSync(join(legacyDirectory, 'stratagate-legacy-citations-v1.json')), `${version}: migration receipt was not published`)
    }
    console.log(`Verified DSH ${version}: complete CLI install, recoverable stale-peer repair, startup, StrataGate admin capability, two session titles/pages, and legacy migration.`)
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}
