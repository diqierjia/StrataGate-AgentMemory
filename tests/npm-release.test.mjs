import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseNpm, inspectArtifact, npmRunner } from '../scripts/release-npm.mjs'

const stageId = '990c643a-cf2b-4f02-8402-2a91e149fcb1'
const bytes = Buffer.from('verified package bytes')
const digest = (data, alg = 'sha256', enc = 'hex') => createHash(alg).update(data).digest(enc)
const identity = { name: 'stratagate-dsh', version: '0.3.99', sha256: digest(bytes), shasum: digest(bytes, 'sha1'), integrity: 'sha512-' + digest(bytes, 'sha512', 'base64') }

function fixture(t) {
  const evidence = mkdtempSync(join(tmpdir(), 'stratagate-release-test-'))
  t.after(() => rmSync(evidence, { recursive: true, force: true }))
  const remote = { stages: [], published: false, tag: identity.version, stageStatus: 'staged' }
  const calls = []
  const stage = () => ({ id: stageId, packageName: identity.name, version: identity.version, shasum: identity.shasum, tag: 'latest', access: 'public', status: remote.stageStatus })
  const statePath = join(evidence, 'npm-release-state.json')
  const io = {
    fetch: async url => {
      calls.push(['fetch', url])
      if (url.endsWith('/dist-tags')) return { status: 200, json: async () => ({ latest: remote.tag }) }
      if (url.endsWith('/package.tgz')) return { status: 200, arrayBuffer: async () => remote.publicBytes ?? bytes }
      return remote.published ? { status: 200, json: async () => ({ dist: { integrity: remote.integrity ?? identity.integrity, tarball: 'https://registry.npmjs.org/package.tgz' } }) } : { status: 404 }
    },
    npm: async (args, interactive) => {
      calls.push(['npm', ...args, { interactive }])
      const verb = args[1]
      if (verb === 'list') return JSON.stringify(remote.stages)
      if (verb === 'view') return JSON.stringify(remote.stages[0])
      if (verb === 'publish') {
        remote.stages = [stage()]
        if (remote.uploadError) throw new Error('upload connection reset')
        return JSON.stringify({ [identity.name]: { integrity: identity.integrity, stageId } })
      }
      if (verb === 'download') {
        writeFileSync(join(evidence, `${identity.name}-${identity.version}-${stageId}.tgz`), remote.downloadBytes ?? bytes)
        return '{}'
      }
      if (verb === 'approve') {
        if (remote.publishBeforeError) remote.published = true
        if (remote.approveError) throw new Error('approval connection reset')
        remote.published = true
        return ''
      }
      throw new Error('Unexpected npm command: ' + args.join(' '))
    },
  }
  const run = (action, extras = {}) => releaseNpm({ action, artifact: '/reviewed.tgz', identity, evidence, ...extras }, io)
  const count = verb => calls.filter(call => call[0] === 'npm' && call[2] === verb).length
  return { evidence, statePath, remote, stage, io, calls, run, count }
}

test('stage uploads without approval; approve reuses the exact downloaded stage and verifies public bytes', async t => {
  const f = fixture(t)
  assert.equal((await f.run('stage')).state, 'STAGE_VERIFIED')
  assert.equal(f.count('approve'), 0)
  assert.equal((await f.run('approve')).state, 'RELEASED')
  assert.equal(f.count('publish'), 1)
  assert.equal(f.count('download'), 1)
  assert.equal(f.count('approve'), 1)
  assert.equal(f.calls.find(call => call[0] === 'npm' && call[2] === 'approve').at(-1).interactive, true)
  assert.equal((await f.run('approve')).state, 'RELEASED')
  assert.equal(f.count('approve'), 1)
})

test('default status and approve never upload a missing stage', async t => {
  const f = fixture(t)
  await f.run(undefined)
  await f.run('approve')
  assert.equal(f.count('publish'), 0)
  assert.equal(f.count('approve'), 0)
})

test('recovers an upload whose server response was lost, without reuploading', async t => {
  const f = fixture(t)
  f.remote.uploadError = true
  await assert.rejects(f.run('stage'), /upload connection reset/)
  assert.equal((await f.run('stage')).state, 'STAGE_VERIFIED')
  assert.equal(f.count('publish'), 1)
})

test('status and verify preserve the guard against repeating an uncertain upload', async t => {
  const f = fixture(t)
  f.remote.uploadError = true
  await assert.rejects(f.run('stage'))
  f.remote.stages = []
  await f.run('status')
  await f.run('verify')
  await assert.rejects(f.run('stage'), /上次上传结果不明/)
  assert.equal(f.count('publish'), 1)
  f.remote.uploadError = false
  await f.run('stage', { retryUpload: true })
  assert.equal(f.count('publish'), 2)
})

test('remote matching stage is adopted even when local state was lost', async t => {
  const f = fixture(t)
  f.remote.stages = [f.stage()]
  assert.equal((await f.run('stage')).state, 'STAGE_VERIFIED')
  assert.equal(f.count('publish'), 0)
})

test('server validation is awaited before downloading or asking for authentication', async t => {
  const f = fixture(t)
  f.remote.stageStatus = 'validating'
  await f.run('stage')
  await f.run('approve')
  assert.equal(f.count('download'), 0)
  assert.equal(f.count('approve'), 0)
  f.remote.stages[0].status = 'staged'
  await f.run('approve')
  assert.equal(f.count('publish'), 1)
  assert.equal(f.count('approve'), 1)
})

test('remote conflicting package or tag blocks upload and approval', async t => {
  const f = fixture(t)
  f.remote.stages = [{ ...f.stage(), shasum: 'another package' }]
  await assert.rejects(f.run('stage'), /远端有同版本/)
  assert.equal(f.count('publish'), 0)
  assert.equal(f.count('approve'), 0)
})

test('tampered downloaded package prevents authentication', async t => {
  const f = fixture(t)
  f.remote.stages = [f.stage()]
  f.remote.downloadBytes = Buffer.from('wrong bytes')
  await assert.rejects(f.run('approve'), /暂存包字节/)
  assert.equal(f.count('approve'), 0)
})

test('approval failure is not automatically retried after status or process restart', async t => {
  const f = fixture(t)
  f.remote.stages = [f.stage()]
  f.remote.approveError = true
  await assert.rejects(f.run('approve'), /approval connection reset/)
  await f.run('status')
  await f.run('verify')
  await assert.rejects(f.run('approve'), /上次确认结果不明/)
  assert.equal(f.count('approve'), 1)
  f.remote.approveError = false
  assert.equal((await f.run('approve', { retryApproval: true })).state, 'RELEASED')
})

test('lost approval response is reconciled with public version, without another authentication', async t => {
  const f = fixture(t)
  f.remote.stages = [f.stage()]
  f.remote.approveError = true
  f.remote.publishBeforeError = true
  assert.equal((await f.run('approve')).state, 'RELEASED')
  await f.run('approve')
  assert.equal(f.count('approve'), 1)
})

test('public byte conflict and tag mismatch never trigger re-publication', async t => {
  const f = fixture(t)
  f.remote.published = true
  f.remote.publicBytes = Buffer.from('tampered')
  await assert.rejects(f.run('verify'), /公开包 SHA-256/)
  f.remote.publicBytes = bytes
  f.remote.tag = '0.3.98'
  assert.equal((await f.run('approve')).state, 'PUBLISHED_TAG_MISMATCH')
  assert.equal(f.count('publish'), 0)
  assert.equal(f.count('approve'), 0)
})

test('registry outage cannot be mistaken for a missing version', async t => {
  const f = fixture(t)
  f.io.fetch = async () => ({ status: 503 })
  await assert.rejects(f.run('stage'), /无法确认公开版本/)
  assert.equal(f.count('publish'), 0)
})

test('published status needs no large download or authentication; verify performs byte comparison', async t => {
  const f = fixture(t)
  f.remote.published = true
  assert.equal((await f.run('status')).state, 'PUBLISHED_NEEDS_VERIFICATION')
  assert.equal(f.calls.filter(call => call[0] === 'fetch' && call[1].endsWith('/package.tgz')).length, 0)
  assert.equal(f.calls.filter(call => call[0] === 'npm').length, 0)
  assert.equal((await f.run('verify')).state, 'RELEASED')
})

test('evidence directory cannot silently switch artifact identity', async t => {
  const f = fixture(t)
  await f.run('status')
  const state = JSON.parse(readFileSync(f.statePath))
  state.sha256 = 'another hash'
  writeFileSync(f.statePath, JSON.stringify(state))
  await assert.rejects(f.run('stage'), /发布记录与包不一致/)
  assert.equal(f.count('publish'), 0)
})

test('CLI rejects a changed artifact before npm; a live lock blocks concurrent runs', t => {
  const f = fixture(t)
  mkdirSync(join(f.evidence, 'package'))
  writeFileSync(join(f.evidence, 'package/package.json'), JSON.stringify({ name: identity.name, version: identity.version }))
  const artifact = join(f.evidence, 'reviewed.tgz')
  execFileSync('tar', ['-czf', artifact, '-C', f.evidence, 'package'])
  const sha256 = digest(readFileSync(artifact))
  assert.equal(inspectArtifact(artifact, sha256).version, identity.version)
  assert.throws(() => inspectArtifact(artifact, '0'.repeat(64)), /包与已审查/)
  writeFileSync(join(f.evidence, 'npm-release.lock'), JSON.stringify({ pid: process.pid }))
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/release-npm.mjs', import.meta.url)),
    '--artifact', artifact, '--sha256', sha256, '--evidence', f.evidence], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /仍在运行/)
  // The wrapper can die while npm is still waiting for browser authentication.
  writeFileSync(join(f.evidence, 'npm-release.lock'), JSON.stringify({ pid: 2147483647, childPid: process.pid }))
  const orphanedChild = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/release-npm.mjs', import.meta.url)),
    '--artifact', artifact, '--sha256', sha256, '--evidence', f.evidence], { encoding: 'utf8' })
  assert.equal(orphanedChild.status, 1)
  assert.match(orphanedChild.stderr, /仍在运行/)
})

test('npm runner preserves literal arguments without a shell and disables automatic retries/browser', async t => {
  const f = fixture(t)
  const fakeCli = join(f.evidence, 'fake-npm.cjs')
  writeFileSync(fakeCli, 'console.log(JSON.stringify(process.argv.slice(2)))')
  const npm = npmRunner(fakeCli, undefined, f.evidence)
  const args = JSON.parse(await npm(['stage', 'list', 'literal $() & value']))
  assert.equal(args[2], 'literal $() & value')
  assert(args.includes('--fetch-retries=0'))
  assert(args.includes('--browser=false'))
  assert.equal(args[args.indexOf('--registry') + 1], 'https://registry.npmjs.org/')
})
