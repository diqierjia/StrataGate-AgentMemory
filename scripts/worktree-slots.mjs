#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const STRATAGATE_PROJECT_ID = 'ae5aca5d-7487-45e8-a32c-2657822268e9'

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function getCommonGitDir(cwd = process.cwd()) {
  const raw = git(['rev-parse', '--git-common-dir'], cwd)
  return resolve(cwd, raw)
}

function getTopLevel(cwd = process.cwd()) {
  return resolve(git(['rev-parse', '--show-toplevel'], cwd))
}

function getBranch(cwd = process.cwd()) {
  try {
    return git(['branch', '--show-current'], cwd) || '(detached)'
  } catch {
    return '(unknown)'
  }
}

function normalizePath(p) {
  return resolve(p).replace(/\\/g, '/').toLowerCase()
}

function getRegistryPath(cwd = process.cwd()) {
  return resolve(getCommonGitDir(cwd), '..', '.worktrees', 'worktree-slots.json')
}

function loadRegistry(cwd = process.cwd()) {
  const file = getRegistryPath(cwd)
  if (!existsSync(file)) return { slots: [] }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data?.slots) ? data : { slots: [] }
  } catch {
    return { slots: [] }
  }
}

function saveRegistry(data, cwd = process.cwd()) {
  const file = getRegistryPath(cwd)
  mkdirSync(dirname(file), { recursive: true })
  const sorted = [...(data.slots || [])].sort((a, b) => Number(a.slot) - Number(b.slot))
  writeFileSync(file, JSON.stringify({ slots: sorted, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
}

function pruneMissingWorktrees(registry) {
  registry.slots = (registry.slots || []).filter((item) => item && Number.isInteger(item.slot) && item.slot > 0 && item.path && existsSync(item.path))
  return registry
}

function smallestAvailableSlot(slots) {
  const used = new Set(slots.map((s) => Number(s.slot)))
  let n = 1
  while (used.has(n)) n += 1
  return n
}

function sanitizeSlug(raw) {
  return String(raw || '')
    .trim()
    .replace(/^codex\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined) return fallback
  return !['false', '0', 'no'].includes(String(value).trim().toLowerCase())
}

function formatThreadTitle(slotNumber, title, { frontend = false, releaseStage = '', versionTag = '' } = {}) {
  const uiTag = frontend ? '🎨' : ''
  if (releaseStage) {
    return `【${releaseStage}${versionTag || '<版本号>'}${uiTag}】${title}`
  }
  return `【${slotNumber}号${uiTag}】${title}`
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(token)
    }
  }
  return { command: positional[0] || 'status', positional: positional.slice(1), flags }
}

function ensureWorktreeDeps(worktreePath, repoRoot) {
  const links = [
    ['node_modules', 'node_modules'],
    ['release-candidates/first-login-browser-fixture/node_modules', 'release-candidates/first-login-browser-fixture/node_modules'],
  ]
  for (const [srcRel, destRel] of links) {
    const src = resolve(repoRoot, srcRel)
    const dest = resolve(worktreePath, destRel)
    if (!existsSync(src) || existsSync(dest)) continue
    try {
      mkdirSync(dirname(dest), { recursive: true })
      symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // non-fatal if symlink/junction is unavailable
    }
  }
}

function buildWorkerPrompt(entry, bugDetail = '') {
  const detail = String(bugDetail || entry.title || '').trim()
  const pendingReleaseTitle = formatThreadTitle(entry.slot, entry.title, {
    frontend: Boolean(entry.frontend),
    releaseStage: '待发版',
    versionTag: '<版本号>',
  })
  return [
    `你已被总管会话分配到 StrataGate 的【${entry.slot} 号工位】。`,
    ``,
    `- 你的工位编号：【${entry.slot} 号工位】`,
    `- 你的专属工作树目录：\`${entry.path}\`（所有终端命令、文件读写、测试与打包必须在此目录下执行，严禁修改主目录或其他工位目录）`,
    `- 你的专属 Git 分支：\`${entry.branch}\`（已从 \`origin/main\` 切出）`,
    `- 任务标题：${entry.title}`,
    detail && detail !== entry.title ? `- 详细需求/Bug 描述：\n${detail}` : '',
    ``,
    `执行要求：`,
    `1. 全程在 \`${entry.path}\` 下定位并修复该问题，不要混入其他工位或主目录的改动。`,
    `2. 每次向用户汇报开头第一行必须输出工位状态（可运行 \`node scripts/worktree-slots.mjs status --path "${entry.path}"\` 获取）：\`当前并行工位：共 N 个 ｜ 我是【${entry.slot} 号工位】\`。`,
    `3. 阶段进展变化时，用 \`node scripts/worktree-slots.mjs claim --path "${entry.path}" --slot ${entry.slot} --state "<当前状态>"\` 更新工位状态（如“排查中”、“本地测试通过·待验收”）。`,
    `4. 修复完成后跑通对应单测/E2E 验证（凡涉及前端或界面展示的改动，必须先打出 \`.tgz\` 候选包而非正式发布，装入桌面版 DeepSeek Harness，用 computer use 基于有旧数据的非空真实库端到端实测并看图确认；交付用户验收时必须直接展示修改前与修改后的对比截图）。本仓库采用**并行开发、顺序合并**（前面独立同时开发，最后严禁多工位并发合入 \`main\`）：等待用户 \`pass\` 并确认轮到自己顺序合并后，先基于最新 \`origin/main\` 变基并递增为**全新的独立版本号**（严禁与前序待发版单共用同一版本号，如已有 \`0.3.60\` 则本单必须先升为 \`0.3.61\`）再合入 \`main\`，随后执行 \`node scripts/worktree-slots.mjs release ${entry.slot}\` 释放工位，并调用 \`set_thread_title\` 去掉工位号改为 \`${pendingReleaseTitle}\`（\`<版本号>\` 取本单独占的新版本号末位，如 \`61\`；正式发版后改为 \`已发版\`；如过程中新增了前端改动，请确保加上 \`🎨\` 标识）。`,
  ].filter(Boolean).join('\n')
}

function printStatus(registry, currentPath) {
  const normCurrent = normalizePath(currentPath)
  const slots = [...(registry.slots || [])].sort((a, b) => Number(a.slot) - Number(b.slot))
  const currentSlot = slots.find((s) => normalizePath(s.path) === normCurrent)
  const header = currentSlot
    ? `当前并行工位：共 ${slots.length} 个 ｜ 我是【${currentSlot.slot} 号工位】`
    : `当前并行工位：共 ${slots.length} 个 ｜ 当前目录未登记工位`
  console.log(header)
  if (slots.length === 0) {
    console.log('- （暂无登记的并行工位）')
    return
  }
  for (const s of slots) {
    const isMe = normalizePath(s.path) === normCurrent
    const tag = isMe ? `【${s.slot} 号工位 · 当前】` : `【${s.slot} 号工位】`
    const threadPart = s.threadId ? `，会话ID: ${s.threadId}` : ''
    console.log(`- ${tag} ${s.title || '未命名任务'}（分支: ${s.branch || '-'}，状态: ${s.state || '进行中'}${threadPart}，目录: ${s.path}）`)
  }
}

const { command, positional, flags } = parseArgs(process.argv.slice(2))
const targetPath = resolve(flags.path || getTopLevel())
const registry = pruneMissingWorktrees(loadRegistry())

if (command === 'create' || command === 'new') {
  const slotNumber = flags.slot ? Number(flags.slot) : smallestAvailableSlot(registry.slots)
  const slug = sanitizeSlug(flags.slug || flags.branch || positional[0] || `task-${slotNumber}`)
  const branchName = flags.branch || `codex/${slug}`
  const commonGitDir = getCommonGitDir()
  const repoRoot = resolve(commonGitDir, '..')
  const worktreePath = resolve(flags.path || resolve(repoRoot, '.worktrees', `slot-${slotNumber}-${slug}`))
  const baseRef = flags.base || 'origin/main'
  if (!existsSync(worktreePath)) {
    mkdirSync(dirname(worktreePath), { recursive: true })
    const branchExists = (() => {
      try {
        git(['rev-parse', '--verify', branchName], repoRoot)
        return true
      } catch {
        return false
      }
    })()
    if (branchExists) {
      git(['worktree', 'add', worktreePath, branchName], repoRoot)
    } else {
      git(['worktree', 'add', '-b', branchName, worktreePath, baseRef], repoRoot)
    }
  }
  ensureWorktreeDeps(worktreePath, repoRoot)
  const taskTitle = flags.title || positional.slice(1).join(' ') || slug
  const isFrontend = parseBooleanFlag(flags.frontend, false)
  const entry = {
    slot: slotNumber,
    title: taskTitle,
    frontend: isFrontend,
    threadTitle: formatThreadTitle(slotNumber, taskTitle, { frontend: isFrontend }),
    branch: branchName,
    path: worktreePath,
    state: flags.state || '进行中',
    threadId: flags['thread-id'] || flags.threadId || null,
    claimedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  registry.slots = registry.slots.filter((s) => Number(s.slot) !== slotNumber && normalizePath(s.path) !== normalizePath(worktreePath))
  registry.slots.push(entry)
  saveRegistry(registry)
  if (flags.json === 'true') {
    console.log(JSON.stringify({
      projectId: STRATAGATE_PROJECT_ID,
      slot: entry.slot,
      title: entry.title,
      frontend: entry.frontend,
      threadTitle: entry.threadTitle,
      branch: entry.branch,
      path: entry.path,
      state: entry.state,
      threadId: entry.threadId,
      workerPrompt: buildWorkerPrompt(entry, flags.bug || flags.prompt || ''),
      slots: registry.slots,
    }, null, 2))
  } else {
    printStatus(registry, worktreePath)
  }
} else if (command === 'claim') {
  const normTarget = normalizePath(targetPath)
  let existing = registry.slots.find((s) => normalizePath(s.path) === normTarget)
  const requestedSlot = flags.slot ? Number(flags.slot) : null
  if (!existing) {
    const slotNumber = requestedSlot && !registry.slots.some((s) => Number(s.slot) === requestedSlot)
      ? requestedSlot
      : smallestAvailableSlot(registry.slots)
    const taskTitle = flags.title || positional.join(' ') || getBranch(targetPath)
    const isFrontend = parseBooleanFlag(flags.frontend, false)
    existing = {
      slot: slotNumber,
      title: taskTitle,
      frontend: isFrontend,
      threadTitle: formatThreadTitle(slotNumber, taskTitle, { frontend: isFrontend }),
      branch: flags.branch || getBranch(targetPath),
      path: targetPath,
      state: flags.state || '进行中',
      threadId: flags['thread-id'] || flags.threadId || null,
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    registry.slots.push(existing)
  } else {
    if (flags.frontend !== undefined) {
      existing.frontend = parseBooleanFlag(flags.frontend, Boolean(existing.frontend))
    }
    if (flags.title || positional.length) {
      existing.title = flags.title || positional.join(' ')
    }
    existing.threadTitle = formatThreadTitle(existing.slot, existing.title, {
      frontend: Boolean(existing.frontend),
    })
    if (flags.state) existing.state = flags.state
    if (flags['thread-id'] || flags.threadId) existing.threadId = flags['thread-id'] || flags.threadId
    existing.branch = flags.branch || getBranch(targetPath)
    existing.updatedAt = new Date().toISOString()
  }
  saveRegistry(registry)
  printStatus(registry, targetPath)
} else if (command === 'bind') {
  const slotNumber = Number(flags.slot || positional[0])
  const target = registry.slots.find((s) => Number(s.slot) === slotNumber)
  if (!target) {
    console.error(`未找到 ${slotNumber} 号工位`)
    process.exit(1)
  }
  if (flags['thread-id'] || flags.threadId) target.threadId = flags['thread-id'] || flags.threadId
  if (flags.state) target.state = flags.state
  if (flags.frontend !== undefined) {
    target.frontend = parseBooleanFlag(flags.frontend, Boolean(target.frontend))
  }
  if (flags.title) {
    target.title = flags.title
  }
  target.threadTitle = formatThreadTitle(target.slot, target.title, {
    frontend: Boolean(target.frontend),
  })
  target.updatedAt = new Date().toISOString()
  saveRegistry(registry)
  printStatus(registry, target.path)
} else if (command === 'release') {
  const slotArg = positional[0] ? Number(positional[0]) : (flags.slot ? Number(flags.slot) : null)
  const normTarget = normalizePath(targetPath)
  const beforeCount = registry.slots.length
  registry.slots = registry.slots.filter((s) => {
    if (slotArg !== null && Number.isInteger(slotArg)) return Number(s.slot) !== slotArg
    return normalizePath(s.path) !== normTarget
  })
  saveRegistry(registry)
  console.log(`已释放工位（移除 ${beforeCount - registry.slots.length} 个），剩余并行工位 ${registry.slots.length} 个。`)
  printStatus(registry, targetPath)
} else {
  try {
    saveRegistry(registry)
  } catch {
    // ignore write error on read-only status checks
  }
  if (flags.json === 'true') {
    console.log(JSON.stringify({ projectId: STRATAGATE_PROJECT_ID, slots: registry.slots }, null, 2))
  } else {
    printStatus(registry, targetPath)
  }
}
