import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tarball = process.argv[2] ? resolve(packageRoot, process.argv[2]) : join(packageRoot, 'stratagate-dsh-0.2.64.tgz')
const versions = ['0.1.2-rc.1', '0.1.5-rc.1']
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

function seedSessions(dshHome) {
  const project = join(dshHome, 'sessions', '--C-redacted-workspace--')
  const fixtures = [
    ['legacy-session-v0', 'fixture-legacy-citations'],
    ['clean-session-v0', 'fixture-clean-session'],
  ]
  for (const [fixture, id] of fixtures) {
    const directory = join(project, id)
    mkdirSync(directory, { recursive: true })
    copyFileSync(join(fixtureRoot, fixture, 'session.jsonl'), join(directory, 'session.jsonl'))
  }
}

async function smokeWeb(cli, root, env, version) {
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
    const exchange = await fetch(launchUrl, { redirect: 'manual' })
    assert(exchange.status === 303, `${version}: launch-token exchange returned HTTP ${exchange.status}`)
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    assert(cookie, `${version}: launch-token exchange did not mint a browser cookie`)
    const response = await fetch(origin, { headers: { cookie } })
    assert(response.ok, `${version}: Web shell returned HTTP ${response.status}`)
    const html = await response.text()
    assert(html.includes('__DSH_BOOT__'), `${version}: Web shell omitted the DSH boot payload`)

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
      assert(envelope.result?.ok === true, `${version}: ${method} failed: ${JSON.stringify(envelope.result?.error)}`)
      return envelope.result.value
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

assert(existsSync(tarball), `Tarball does not exist: ${tarball}`)
const roots = []
try {
  for (const version of versions) {
    const root = mkdtempSync(join(tmpdir(), `stratagate-dsh-${version.replaceAll('.', '_')}-`))
    roots.push(root)
    const dshHome = join(root, 'dsh-home')
    seedSessions(dshHome)
    run(npm, ['init', '--yes'], root)
    // Install the CLI as a whole. Its package.json intentionally resolves the
    // internal 0.1.5 packages to rc.2; do not replace that tree package-by-package.
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
    const stale = join(profile, 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(stale, { recursive: true })
    const staleVersion = version === '0.1.5-rc.1' ? '0.1.2-rc.1' : '0.1.5-rc.2'
    writeFileSync(join(stale, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: staleVersion }))

    // A second add exercises an in-place upgrade with the existing lockfile and
    // profile generation. The stale directory remains recoverable on disk, but
    // the bootstrap resolver must force StrataGate onto the host-owned tree.
    run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tarball], root, dshEnv)
    assert(existsSync(stale), `${version}: upgrade unexpectedly deleted the seeded legacy package`)
    const repair = run(process.execPath, [cli, 'plugin', '--profile', 'web', 'exec', 'stratagate-dsh-repair'], root, dshEnv)
    assert(repair.includes('Quarantined'), `${version}: profile repair did not report a quarantine`)
    assert(!existsSync(stale), `${version}: profile repair left the stale DSH package active`)
    const backups = join(profile, '.stratagate-runtime-backups')
    assert(existsSync(backups), `${version}: profile repair did not create a recoverable backup`)

    const config = run(process.execPath, [cli, '--profile', 'web', '--dump-config'], root, dshEnv)
    assert(config.includes("sessionRoot: !!js dshHomePath('sessions')"), `${version}: sessionRoot was not wired to the host DSH_HOME`)
    await smokeWeb(cli, root, dshEnv, version)
    const legacyDirectory = join(dshHome, 'sessions', '--C-redacted-workspace--', 'fixture-legacy-citations')
    assert(existsSync(join(legacyDirectory, 'session.jsonl')), `${version}: immutable v0 fixture was removed`)
    if (version === '0.1.5-rc.1') {
      assert(existsSync(join(legacyDirectory, 'session.v1.jsonl')), `${version}: legacy citation bridge was not published`)
      assert(existsSync(join(legacyDirectory, 'stratagate-legacy-citations-v1.json')), `${version}: migration receipt was not published`)
    }
    console.log(`Verified DSH ${version}: complete CLI install, recoverable stale-peer repair, startup, two session titles/pages, and legacy migration.`)
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}
