import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildWorkerPrompt,
  collectVersionQueue,
  formatThreadTitle,
  formatVersionQueueLines,
  parseArgs,
  resolveChoreFlag,
} from '../scripts/worktree-slots.mjs'

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/worktree-slots.mjs', import.meta.url))

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function writePkg(dir, version, lockVersion = version) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stratagate-dsh', version }, null, 2) + '\n', 'utf8')
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'stratagate-dsh', version, lockfileVersion: 3, packages: { '': { version: lockVersion } } }, null, 2) + '\n',
    'utf8',
  )
}

function setupMockRepo() {
  const root = mkdtempSync(join(tmpdir(), 'worktree-slots-test-'))
  runGit(['init', '-b', 'main'], root)
  runGit(['config', 'user.email', 'test@example.com'], root)
  runGit(['config', 'user.name', 'Test User'], root)

  writePkg(root, '0.3.60')
  runGit(['add', 'package.json', 'package-lock.json'], root)
  runGit(['commit', '-m', 'chore: release 0.3.60'], root)
  runGit(['tag', 'stratagate-dsh-v0.3.60'], root)

  writePkg(root, '0.3.61')
  runGit(['add', 'package.json', 'package-lock.json'], root)
  runGit(['commit', '-m', 'fix: queued PR 0.3.61'], root)

  writePkg(root, '0.3.62')
  runGit(['add', 'package.json', 'package-lock.json'], root)
  runGit(['commit', '-m', 'docs: queued PR 0.3.62'], root)
  return root
}

test('formatThreadTitle and flag parsing support --chore / --non-business and --frontend', () => {
  const parsedChore = parseArgs(['create', '--slug', 'docs', '--chore', '--title', '更新规范'])
  assert.equal(parsedChore.command, 'create')
  assert.equal(resolveChoreFlag(parsedChore.flags), true)

  const parsedAlias = parseArgs(['claim', '--non-business', '--frontend'])
  assert.equal(resolveChoreFlag(parsedAlias.flags), true)
  assert.equal(parsedAlias.flags.frontend, 'true')

  const parsedFalse = parseArgs(['claim', '--chore', 'false'])
  assert.equal(resolveChoreFlag(parsedFalse.flags), false)

  assert.equal(formatThreadTitle(1, '修脚本'), '【1号】修脚本')
  assert.equal(formatThreadTitle(1, '修脚本', { chore: true }), '【1号🔧】修脚本')
  assert.equal(formatThreadTitle(2, '改样式', { frontend: true }), '【2号🎨】改样式')
  assert.equal(formatThreadTitle(3, '改构建面板', { frontend: true, chore: true }), '【3号🎨🔧】改构建面板')
  assert.equal(formatThreadTitle(1, '修脚本', { chore: true, releaseStage: '待发版', versionTag: '63' }), '【待发版63🔧】修脚本')
  assert.equal(formatThreadTitle(1, '修脚本', { chore: true, releaseStage: '已发版', versionTag: '63' }), '【已发版63🔧】修脚本')
})

test('collectVersionQueue lists queued versions, next available version, and non-blocking collision warnings', async () => {
  const repoRoot = setupMockRepo()
  try {
    const slot1Path = join(repoRoot, '.worktrees', 'slot-1-one')
    const slot2Path = join(repoRoot, '.worktrees', 'slot-2-two')
    mkdirSync(join(repoRoot, '.worktrees'), { recursive: true })
    runGit(['worktree', 'add', '-b', 'codex/one', slot1Path, 'main'], repoRoot)
    runGit(['worktree', 'add', '-b', 'codex/two', slot2Path, 'main'], repoRoot)
    writePkg(slot2Path, '0.3.62', '0.3.61')

    const registry = {
      slots: [
        { slot: 1, title: '非业务脚本', branch: 'codex/one', path: slot1Path, frontend: false, chore: true },
        { slot: 2, title: '前端修改', branch: 'codex/two', path: slot2Path, frontend: true, chore: false },
      ],
    }

    const queueInfo = await collectVersionQueue({
      targetPath: slot1Path,
      repoRoot,
      registry,
      checkRemote: true,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ latest: '0.3.60' }),
      }),
    })

    assert.equal(queueInfo.latestTag, 'stratagate-dsh-v0.3.60')
    assert.equal(queueInfo.npmLatest, '0.3.60')
    assert.equal(queueInfo.mainVersion, '0.3.62')
    assert.deepEqual(queueInfo.queuedVersions, ['0.3.61', '0.3.62'])
    assert.equal(queueInfo.nextVersion, '0.3.63')
    assert.ok(queueInfo.warnings.some((w) => w.includes('与 main（0.3.62）重复') || w.includes('与 origin/main（0.3.62）重复')))
    assert.ok(queueInfo.warnings.some((w) => w.includes('【2 号工位】') && w.includes('重复')))

    writePkg(slot1Path, '0.3.63')
    writePkg(slot2Path, '0.3.63')
    const collidedQueue = await collectVersionQueue({
      targetPath: slot1Path,
      repoRoot,
      registry,
      checkRemote: true,
      fetchImpl: async () => {
        throw new Error('offline should not throw')
      },
    })
    assert.equal(collidedQueue.npmLatest, null)
    assert.equal(collidedQueue.nextVersion, '0.3.64')
    assert.ok(collidedQueue.warnings.some((w) => w.includes('0.3.63') && w.includes('【2 号工位】')))

    const detailedLines = formatVersionQueueLines(collidedQueue, { detailed: true }).join('\n')
    assert.match(detailedLines, /待发版队列：0\.3\.61、0\.3\.62/)
    assert.match(detailedLines, /【1 号工位🔧】0\.3\.63/)
    assert.match(detailedLines, /【2 号工位🎨】0\.3\.63/)
    assert.match(detailedLines, /下一可用递增版本：0\.3\.64/)
    assert.match(detailedLines, /⚠️ 非阻塞提醒/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('buildWorkerPrompt includes queue guidance and respects --chore vs --frontend requirements', () => {
  const queueInfo = {
    latestTag: 'stratagate-dsh-v0.3.60',
    mainRef: 'origin/main',
    mainVersion: '0.3.62',
    queuedVersions: ['0.3.61', '0.3.62'],
    activeSlotVersions: [{ slot: 2, version: '0.3.63' }],
    nextVersion: '0.3.64',
    warnings: ['⚠️ 非阻塞提醒：当前工作树版本 0.3.62 与 origin/main（0.3.62）重复'],
  }

  const chorePrompt = buildWorkerPrompt(
    {
      slot: 1,
      title: '补充排队提醒',
      frontend: false,
      chore: true,
      branch: 'codex/queue',
      path: 'C:/repo/.worktrees/slot-1-queue',
    },
    '更新脚本与文档',
    queueInfo,
  )
  assert.match(chorePrompt, /非业务代码任务 🔧/)
  assert.match(chorePrompt, /一个 PR 一个独立版本/)
  assert.match(chorePrompt, /0\.3\.61、0\.3\.62、0\.3\.63/)
  assert.match(chorePrompt, /0\.3\.64/)
  assert.match(chorePrompt, /【待发版<版本号>🔧】补充排队提醒/)
  assert.doesNotMatch(chorePrompt, /对比截图/)

  const frontendPrompt = buildWorkerPrompt(
    {
      slot: 2,
      title: '调整按钮样式',
      frontend: true,
      chore: false,
      branch: 'codex/ui',
      path: 'C:/repo/.worktrees/slot-2-ui',
    },
    '',
    queueInfo,
  )
  assert.match(frontendPrompt, /前端任务 🎨/)
  assert.match(frontendPrompt, /对比截图/)
  assert.match(frontendPrompt, /【待发版<版本号>🎨】调整按钮样式/)
})

test('CLI create, claim, bind, queue, status, and release persist chore and exit 0 on warnings', () => {
  const repoRoot = setupMockRepo()
  try {
    const createdRaw = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        'create',
        '--slug',
        'chore-task',
        '--title',
        '脚本与文档',
        '--base',
        'main',
        '--chore',
        '--offline',
        '--json',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    const created = JSON.parse(createdRaw)
    assert.equal(created.slot, 1)
    assert.equal(created.chore, true)
    assert.equal(created.frontend, false)
    assert.equal(created.threadTitle, '【1号🔧】脚本与文档')
    assert.equal(created.queue.nextVersion, '0.3.63')
    assert.ok(created.queue.warnings.length > 0)

    const queueRaw = execFileSync(
      process.execPath,
      [SCRIPT_PATH, 'queue', '--path', created.path, '--offline'],
      { cwd: created.path, encoding: 'utf8' },
    )
    assert.match(queueRaw, /下一可用递增版本：0\.3\.63/)
    assert.match(queueRaw, /⚠️ 非阻塞提醒/)

    execFileSync(
      process.execPath,
      [SCRIPT_PATH, 'bind', '--slot', '1', '--thread-id', 'thread-123', '--state', '本地测试通过', '--offline'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    const registry = JSON.parse(readFileSync(resolve(repoRoot, '.worktrees', 'worktree-slots.json'), 'utf8'))
    assert.equal(registry.slots[0].chore, true)
    assert.equal(registry.slots[0].threadId, 'thread-123')

    const statusOut = execFileSync(
      process.execPath,
      [SCRIPT_PATH, 'status', '--path', created.path, '--offline'],
      { cwd: created.path, encoding: 'utf8' },
    )
    assert.match(statusOut, /【1 号工位🔧 · 当前】/)
    assert.match(statusOut, /版本排队提醒：/)

    const releaseOut = execFileSync(
      process.execPath,
      [SCRIPT_PATH, 'release', '1', '--offline'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    assert.match(releaseOut, /剩余并行工位 0 个/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
