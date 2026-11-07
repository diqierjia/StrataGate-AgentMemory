import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const formalVersionPattern = /^\d+\.\d+\.\d+$/
const candidateVersionPattern = /^(\d+\.\d+\.\d+)-candidate\.(\d+)$/

export function assertCandidateVersion(sourceVersion, candidateVersion) {
  assert.match(sourceVersion, formalVersionPattern, `源码版本必须是正式三段版本，实际为 ${sourceVersion}`)
  const match = candidateVersion.match(candidateVersionPattern)
  assert(match, `候选版本必须形如 ${sourceVersion}-candidate.N，实际为 ${candidateVersion}`)
  assert.equal(match[1], sourceVersion, `候选版本必须基于源码版本 ${sourceVersion}`)
  return Number(match[2])
}

export function rewritePackageVersions(stageRoot, version) {
  const packagePath = join(stageRoot, 'package.json')
  const lockPath = join(stageRoot, 'package-lock.json')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'))
  manifest.version = version
  lockfile.version = version
  if (lockfile.packages?.['']) lockfile.packages[''].version = version
  writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(lockPath, JSON.stringify(lockfile, null, 2) + '\n')
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

function packJson(output) {
  const start = Math.max(output.lastIndexOf('\n['), output.startsWith('[') ? 0 : -1)
  assert(start >= 0, `npm pack did not return JSON:\n${output}`)
  return JSON.parse(output.slice(start).trim())[0]
}

export function stageCandidate({ sourceRoot = root, sourceRef = 'HEAD', version, output }) {
  assert(version && output, '必须提供 --version 和 --output')
  const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
  assertCandidateVersion(sourceManifest.version, version)
  const outputRoot = resolve(output)
  mkdirSync(outputRoot, { recursive: true })
  const stage = mkdtempSync(join(tmpdir(), 'stratagate-dsh-candidate-'))
  const archive = join(stage, 'source.tar')
  const extracted = join(stage, 'source')
  mkdirSync(extracted)
  try {
    execFileSync('git', ['archive', '--format=tar', '--prefix=package/', '--output', archive, sourceRef], { cwd: sourceRoot, stdio: 'ignore' })
    run('tar', ['-xf', archive, '-C', extracted], sourceRoot)
    const packageRoot = join(extracted, 'package')
    rewritePackageVersions(packageRoot, version)
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], packageRoot)
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:dsh'], packageRoot)
    const packed = packJson(run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outputRoot], packageRoot))
    const tarball = resolve(outputRoot, basename(packed.filename))
    assert(existsSync(tarball), `候选包未生成：${tarball}`)
    return { tarball, version, sourceRef }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function main() {
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, output: { type: 'string' }, ref: { type: 'string', default: 'HEAD' }, help: { type: 'boolean' },
  } })
  if (values.help) return console.log('用法：node scripts/stage-candidate.mjs --version 0.3.42-candidate.1 --output <暂存目录> [--ref HEAD]')
  const result = stageCandidate({ version: values.version, output: values.output, sourceRef: values.ref })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
