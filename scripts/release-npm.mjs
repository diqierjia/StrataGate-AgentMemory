import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { resolve, join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const registry = 'https://registry.npmjs.org/'
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n')
  renameSync(path + '.tmp', path)
}

export function inspectArtifact(artifact, expectedSha256) {
  const bytes = readFileSync(artifact)
  assert.match(expectedSha256, /^[a-f0-9]{64}$/i, '必须提供已审查正式包的 SHA-256')
  assert.equal(hash(bytes), expectedSha256.toLowerCase(), '包与已审查 SHA-256 不一致')
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }))
  assert.equal(manifest.name, 'stratagate-dsh')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, '仅接受正式三段版本；请先完成正式包校验')
  return { name: manifest.name, version: manifest.version, sha256: hash(bytes), shasum: hash(bytes, 'sha1'), integrity: 'sha512-' + hash(bytes, 'sha512', 'base64') }
}

export function npmRunner(npmCli, userconfig, cwd, onChild = () => {}) {
  assert(npmCli && existsSync(npmCli), '请用 --npm-cli 指定支持 npm stage 的 npm-cli.js（或通过 npm 执行此脚本）')
  return (args, interactive = false) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args, '--registry', registry, '--fetch-retries=0', '--fetch-timeout=600000', '--browser=false',
      ...(userconfig ? ['--userconfig', userconfig] : [])], {
      cwd, shell: false, env: { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH },
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    if (child.pid) onChild(child.pid)
    let stdout = '', stderr = ''
    if (!interactive) {
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000) })
    }
    child.on('error', reject)
    child.on('close', code => {
      onChild(null)
      if (code === 0) resolveRun(stdout)
      else reject(new Error(`npm 操作失败（退出码 ${code}）。${/E401|ENEEDAUTH/.test(stderr) ? '请在自己的 Edge 中完成 npm 登录。' : '请检查当前 npm 进程或日志；脚本不会自动重复认证。'}`))
    })
  })
}

export async function releaseNpm(options, io) {
  const { action = 'status', artifact, identity, evidence, tag = 'latest', retryUpload = false, retryApproval = false } = options
  assert(['status', 'stage', 'approve', 'verify'].includes(action), 'action 必须为 status/stage/approve/verify')
  assert.match(tag, /^[a-z][a-z0-9-]*$/, '无效的 dist-tag')
  mkdirSync(evidence, { recursive: true })
  const statePath = join(evidence, 'npm-release-state.json')
  const state = existsSync(statePath) ? json(statePath) : { ...identity, tag, state: 'PREPARED' }
  for (const key of ['name', 'version', 'sha256', 'shasum', 'integrity']) assert.equal(state[key], identity[key], '发布记录与包不一致：' + key)
  assert.equal(state.tag, tag, '不能在恢复发布时更换 tag')
  const persist = (status, extra = {}) => {
    Object.assign(state, extra, { state: status, updatedAt: new Date().toISOString() })
    save(statePath, state)
    return state
  }
  const publicStatus = async (verifyBytes = action === 'verify') => {
    const response = await io.fetch(`${registry}${identity.name}/${identity.version}`)
    if (response.status === 404) return false
    assert.equal(response.status, 200, '无法确认公开版本；停止操作，不重新发布')
    const published = await response.json()
    assert.equal(published.dist?.integrity, identity.integrity, '公开版本与本地包冲突；不能覆盖')
    const tarball = new URL(published.dist.tarball)
    assert.equal(tarball.origin, new URL(registry).origin, '非官方 npm 下载地址')
    if (verifyBytes) {
      const download = await io.fetch(tarball.href)
      assert.equal(download.status, 200, '公开包下载失败；稍后 verify，不重新发布')
      assert.equal(hash(Buffer.from(await download.arrayBuffer())), identity.sha256, '公开包 SHA-256 不一致')
      state.publicBytesMatch = true
    }
    const tags = await io.fetch(`${registry}-/package/${identity.name}/dist-tags`)
    assert.equal(tags.status, 200)
    const actualTagVersion = (await tags.json())[tag]
    persist(actualTagVersion !== identity.version ? 'PUBLISHED_TAG_MISMATCH' : state.publicBytesMatch ? 'RELEASED' : 'PUBLISHED_NEEDS_VERIFICATION', { actualTagVersion })
    return true
  }
  if (await publicStatus()) return state
  if (action === 'verify') return persist('PUBLIC_VERSION_NOT_VISIBLE')

  const stages = JSON.parse(await io.npm(['stage', 'list', identity.name, '--json']))
  assert(Array.isArray(stages), '无法识别 npm 暂存列表；停止操作')
  const sameVersion = stages.filter(item => item.packageName === identity.name && item.version === identity.version)
  const matching = sameVersion.filter(item => item.shasum === identity.shasum && item.tag === tag && item.access === 'public' && ['validating', 'staged', 'approved'].includes(item.status))
  assert(!sameVersion.some(item => ['validating', 'staged', 'approved'].includes(item.status) && !matching.includes(item)), '远端有同版本但内容、tag 或权限不同的暂存包；请先核对')
  let stage = state.stageId ? matching.find(item => item.id === state.stageId) : undefined
  if (!stage) {
    assert(matching.length <= 1, '有多个相同暂存包；需先确定使用哪一个，不能重复认证')
    stage = matching[0]
  }
  if (!stage) {
    if (action !== 'stage') return persist('NO_REUSABLE_STAGE')
    assert(!(state.uploadUncertain || state.stageId) || retryUpload, '上次上传结果不明或暂存包已不可见；先检查远端，确认未成功后再用 --retry-upload')
    persist('UPLOADING', { uploadUncertain: true })
    try {
      const result = JSON.parse(await io.npm(['stage', 'publish', artifact, '--access=public', `--tag=${tag}`, '--ignore-scripts', '--provenance=false', '--json']))
      const packed = result[identity.name]
      assert.equal(packed.integrity, identity.integrity)
      assert.match(packed.stageId, uuid)
      persist('UPLOADED', { stageId: packed.stageId, uploadUncertain: false })
      stage = JSON.parse(await io.npm(['stage', 'view', packed.stageId, '--json']))
    } catch (error) {
      persist('UPLOAD_UNCERTAIN')
      throw error
    }
  }
  assert.match(stage.id, uuid)
  assert.equal(stage.packageName, identity.name)
  assert.equal(stage.version, identity.version)
  assert.equal(stage.shasum, identity.shasum)
  assert.equal(stage.tag, tag)
  assert.equal(stage.access, 'public')
  // Preserve uncertain approval across status calls and process restarts.
  const approvalUncertain = Boolean(state.approvalAttempted)
  persist(approvalUncertain ? 'APPROVAL_UNCERTAIN' : 'STAGED', { stageId: stage.id, stageStatus: stage.status, uploadUncertain: false })
  if (stage.status !== 'staged' || action === 'status') return state

  const downloaded = join(evidence, `${identity.name}-${identity.version}-${stage.id}.tgz`)
  if (!existsSync(downloaded)) await io.npm(['stage', 'download', stage.id, '--json'])
  assert.equal(hash(readFileSync(downloaded)), identity.sha256, '暂存包字节与已审查包不一致；禁止认证发布')
  persist(approvalUncertain ? 'APPROVAL_UNCERTAIN' : 'STAGE_VERIFIED', { stageBytesMatch: true })
  if (action !== 'approve') return state
  assert(!approvalUncertain || retryApproval, '上次确认结果不明；先 status/verify，确需重新认证时再用 --retry-approval')
  // Narrow the window between checking public state and asking for authentication.
  if (await publicStatus()) return state
  persist('APPROVING', { approvalAttempted: true })
  try {
    await io.npm(['stage', 'approve', stage.id], true)
  } catch (error) {
    persist('APPROVAL_UNCERTAIN')
    if (await publicStatus(true)) return state
    throw error
  }
  persist('APPROVED')
  if (!await publicStatus(true)) persist('APPROVED_WAITING_PUBLIC')
  return state
}

function acquireLock(evidence) {
  mkdirSync(evidence, { recursive: true })
  const path = join(evidence, 'npm-release.lock')
  if (existsSync(path)) {
    const previous = json(path)
    for (const pid of [previous.pid, previous.childPid].filter(value => value != null)) {
      assert(Number.isSafeInteger(pid) && pid > 0, '无效进程锁；请先核对原进程')
      let alive = true
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
      assert(!alive, `发布进程 ${pid} 仍在运行；查看原进程，不启动第二次认证`)
    }
    unlinkSync(path)
  }
  const fd = openSync(path, 'wx')
  writeFileSync(fd, JSON.stringify({ pid: process.pid }))
  closeSync(fd)
  return () => unlinkSync(path)
}

async function main() {
  const { values } = parseArgs({ options: {
    action: { type: 'string', default: 'status' }, artifact: { type: 'string' }, sha256: { type: 'string' }, evidence: { type: 'string' },
    'npm-cli': { type: 'string', default: process.env.npm_execpath }, userconfig: { type: 'string' }, tag: { type: 'string', default: 'latest' },
    'retry-upload': { type: 'boolean' }, 'retry-approval': { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) return console.log('用法：node scripts/release-npm.mjs --action status|stage|approve|verify --artifact <正式包.tgz> --sha256 <已审查哈希> --evidence <证据目录> --npm-cli <npm-cli.js> [--userconfig <npmrc>]\n默认只检查状态。stage 上传暂存包；approve 仅在已有暂存包通过校验后认证发布。详见 docs/npm-release.md。')
  assert(values.artifact && values.sha256 && values.evidence, '必须提供 --artifact、--sha256、--evidence')
  const artifact = resolve(values.artifact), evidence = resolve(values.evidence)
  const identity = inspectArtifact(artifact, values.sha256)
  const release = acquireLock(evidence)
  try {
    const state = await releaseNpm({ action: values.action, artifact, identity, evidence, tag: values.tag,
      retryUpload: values['retry-upload'], retryApproval: values['retry-approval'] }, {
      npm: npmRunner(values['npm-cli'] && resolve(values['npm-cli']), values.userconfig && resolve(values.userconfig), evidence,
        childPid => save(join(evidence, 'npm-release.lock'), { pid: process.pid, childPid })),
      fetch: url => fetch(url, { signal: AbortSignal.timeout(120000) }),
    })
    console.log(JSON.stringify(state, null, 2))
  } finally { release() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
