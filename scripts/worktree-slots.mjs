#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STRATAGATE_PROJECT_ID = 'ae5aca5d-7487-45e8-a32c-2657822268e9'
const BOOLEAN_FLAGS = new Set([
  'frontend',
  'chore',
  'non-business',
  'nonBusiness',
  'json',
  'offline',
  'remote',
  'npm',
])

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

export function resolveChoreFlag(flags = {}, fallback = undefined) {
  if (flags.chore !== undefined) return parseBooleanFlag(flags.chore, Boolean(fallback))
  if (flags['non-business'] !== undefined) return parseBooleanFlag(flags['non-business'], Boolean(fallback))
  if (flags.nonBusiness !== undefined) return parseBooleanFlag(flags.nonBusiness, Boolean(fallback))
  return fallback
}

export function parseSemver(raw) {
  if (typeof raw !== 'string') return null
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const prerelease = match[4] ? match[4].split('.') : []
  return {
    major,
    minor,
    patch,
    prerelease,
    raw: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}`,
  }
}

export function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a
  const pb = typeof b === 'string' ? parseSemver(b) : b
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const ia = pa.prerelease[i]
    const ib = pb.prerelease[i]
    if (ia === undefined) return -1
    if (ib === undefined) return 1
    const na = /^\d+$/.test(ia) ? Number(ia) : null
    const nb = /^\d+$/.test(ib) ? Number(ib) : null
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb
    } else if (na !== null) {
      return -1
    } else if (nb !== null) {
      return 1
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1
    }
  }
  return 0
}

export function incrementPatchVersion(version) {
  const parsed = parseSemver(version)
  if (!parsed) return '0.0.1'
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

export function formatThreadTitle(
  slotNumber,
  title,
  { frontend = false, chore = false, releaseStage = '', versionTag = '' } = {},
) {
  const tags = `${frontend ? '🎨' : ''}${chore ? '🔧' : ''}`
  if (releaseStage) {
    return `【${releaseStage}${versionTag || '<版本号>'}${tags}】${title}`
  }
  return `【${slotNumber}号${tags}】${title}`
}

export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eqIdx = body.indexOf('=')
      if (eqIdx !== -1) {
        flags[body.slice(0, eqIdx)] = body.slice(eqIdx + 1)
        continue
      }
      const key = body
      const next = argv[i + 1]
      const isBooleanLiteral = next !== undefined && ['true', 'false', '1', '0', 'yes', 'no'].includes(next.toLowerCase())
      if (next !== undefined && !next.startsWith('--') && (!BOOLEAN_FLAGS.has(key) || isBooleanLiteral)) {
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

function readPackageVersion(pkgPath) {
  if (!pkgPath || !existsSync(pkgPath)) return null
  try {
    const data = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return parseSemver(data?.version)?.raw || null
  } catch {
    return null
  }
}

function readPackageLockVersion(lockPath) {
  if (!lockPath || !existsSync(lockPath)) return null
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8'))
    const raw = data?.packages?.['']?.version || data?.version
    return parseSemver(raw)?.raw || null
  } catch {
    return null
  }
}

function readGitPackageVersion(ref, repoRoot, gitRunner = git) {
  if (!ref) return null
  try {
    const raw = gitRunner(['show', `${ref}:package.json`], repoRoot)
    const data = JSON.parse(raw)
    return parseSemver(data?.version)?.raw || null
  } catch {
    return null
  }
}

function parseReleaseTagList(rawTags) {
  const parsed = []
  for (const line of String(rawTags || '').split(/\r?\n/)) {
    const tag = line.trim()
    if (!tag) continue
    const match = tag.match(/^stratagate-dsh-v(.+)$/)
    if (!match) continue
    const sem = parseSemver(match[1])
    if (!sem) continue
    parsed.push({ tag, version: sem.raw })
  }
  parsed.sort((a, b) => compareSemver(b.version, a.version))
  return parsed
}

async function queryNpmLatest(packageName = 'stratagate-dsh', { timeoutMs = 1500, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res || !res.ok) return null
    const data = await res.json()
    return parseSemver(data?.latest)?.raw || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function queryRemoteLatestTag(repoRoot, { timeoutMs = 1500 } = {}) {
  try {
    const raw = execFileSync('git', ['ls-remote', '--tags', 'origin', 'stratagate-dsh-v*'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tags = []
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const ref = parts[1]
      if (ref.endsWith('^{}')) continue
      const tagName = ref.replace(/^refs\/tags\//, '')
      tags.push(tagName)
    }
    return parseReleaseTagList(tags.join('\n'))[0] || null
  } catch {
    return null
  }
}

export async function collectVersionQueue({
  targetPath = process.cwd(),
  repoRoot = null,
  registry = null,
  checkRemote = false,
  remoteTimeoutMs = 1500,
  fetchImpl = globalThis.fetch,
  packageName = 'stratagate-dsh',
  gitRunner = git,
} = {}) {
  const resolvedTarget = resolve(targetPath)
  const resolvedRepoRoot = repoRoot
    ? resolve(repoRoot)
    : (() => {
        try {
          return resolve(getCommonGitDir(resolvedTarget), '..')
        } catch {
          return resolvedTarget
        }
      })()
  const activeRegistry = registry || pruneMissingWorktrees(loadRegistry(resolvedTarget))
  const offline = process.env.STRATAGATE_OFFLINE === '1'

  let localTags = []
  try {
    localTags = parseReleaseTagList(gitRunner(['tag', '--list', 'stratagate-dsh-v*'], resolvedRepoRoot))
  } catch {
    localTags = []
  }
  const latestLocalTagInfo = localTags[0] || null

  let remoteLatestTagInfo = null
  let npmLatest = null
  if (checkRemote && !offline) {
    remoteLatestTagInfo = queryRemoteLatestTag(resolvedRepoRoot, { timeoutMs: remoteTimeoutMs })
    npmLatest = await queryNpmLatest(packageName, { timeoutMs: remoteTimeoutMs, fetchImpl })
  }

  const latestTagInfo =
    remoteLatestTagInfo && (!latestLocalTagInfo || compareSemver(remoteLatestTagInfo.version, latestLocalTagInfo.version) > 0)
      ? remoteLatestTagInfo
      : latestLocalTagInfo

  const mainRef = (() => {
    for (const candidate of ['origin/main', 'main', 'HEAD']) {
      try {
        gitRunner(['rev-parse', '--verify', candidate], resolvedRepoRoot)
        return candidate
      } catch {
        // try next ref
      }
    }
    return null
  })()

  const mainVersion = readGitPackageVersion(mainRef, resolvedRepoRoot, gitRunner) || readPackageVersion(resolve(resolvedRepoRoot, 'package.json'))

  const queuedCommits = []
  const queuedVersions = []
  const seenQueuedVersion = new Set()
  if (latestLocalTagInfo && mainRef) {
    try {
      const logOutput = gitRunner(
        ['log', '--first-parent', '--reverse', '--format=%H\t%h\t%s', `${latestLocalTagInfo.tag}..${mainRef}`],
        resolvedRepoRoot,
      )
      let prevVersion = latestLocalTagInfo.version
      for (const line of logOutput.split(/\r?\n/)) {
        if (!line.trim()) continue
        const [hash, shortHash, ...subjectParts] = line.split('\t')
        const subject = subjectParts.join('\t')
        const commitVersion = readGitPackageVersion(hash, resolvedRepoRoot, gitRunner)
        const bumped = Boolean(commitVersion && prevVersion && compareSemver(commitVersion, prevVersion) > 0)
        queuedCommits.push({
          hash,
          shortHash,
          subject,
          version: commitVersion,
          bumped,
        })
        if (
          bumped &&
          (!latestTagInfo || compareSemver(commitVersion, latestTagInfo.version) > 0) &&
          !seenQueuedVersion.has(commitVersion)
        ) {
          seenQueuedVersion.add(commitVersion)
          queuedVersions.push(commitVersion)
        }
        if (commitVersion) prevVersion = commitVersion
      }
    } catch {
      // ignore commit log lookup failure on shallow checkouts
    }
  }
  if (
    mainVersion &&
    (!latestTagInfo || compareSemver(mainVersion, latestTagInfo.version) > 0) &&
    !seenQueuedVersion.has(mainVersion)
  ) {
    seenQueuedVersion.add(mainVersion)
    queuedVersions.push(mainVersion)
  }

  const activeSlotVersions = (activeRegistry.slots || [])
    .slice()
    .sort((a, b) => Number(a.slot) - Number(b.slot))
    .map((s) => ({
      slot: s.slot,
      title: s.title,
      branch: s.branch,
      path: s.path,
      frontend: Boolean(s.frontend),
      chore: Boolean(s.chore),
      version: readPackageVersion(resolve(s.path, 'package.json')),
    }))

  const currentVersion = readPackageVersion(resolve(resolvedTarget, 'package.json'))
  const currentLockVersion = readPackageLockVersion(resolve(resolvedTarget, 'package-lock.json'))
  const currentBranch = getBranch(resolvedTarget)
  const normTarget = normalizePath(resolvedTarget)
  const currentSlot = activeSlotVersions.find((s) => normalizePath(s.path) === normTarget) || null

  const occupiedSet = new Set()
  for (const candidate of [
    latestTagInfo?.version,
    npmLatest,
    mainVersion,
    ...queuedVersions,
    ...activeSlotVersions.map((s) => s.version),
  ]) {
    const parsed = parseSemver(candidate)
    if (parsed) occupiedSet.add(parsed.raw)
  }
  const occupiedVersions = [...occupiedSet].sort(compareSemver)
  let nextVersion = occupiedVersions.length ? incrementPatchVersion(occupiedVersions[occupiedVersions.length - 1]) : '0.0.1'
  while (occupiedSet.has(nextVersion)) {
    nextVersion = incrementPatchVersion(nextVersion)
  }

  const warnings = []
  const isWorktreeOrFeatureBranch = Boolean(
    currentSlot || (currentBranch && currentBranch !== 'main' && currentBranch !== '(detached)' && currentBranch !== '(unknown)'),
  )
  const queuedListText = queuedVersions.length ? queuedVersions.join('、') : mainVersion || '无'

  if (isWorktreeOrFeatureBranch && currentVersion) {
    if (mainVersion && compareSemver(currentVersion, mainVersion) === 0) {
      warnings.push(
        `⚠️ 非阻塞提醒：当前工作树版本 ${currentVersion} 与 ${mainRef || 'origin/main'}（${mainVersion}）重复，合入前请顺延递增至 ${nextVersion}（勿占用已排队版本：${queuedListText}）。`,
      )
    } else if (mainVersion && compareSemver(currentVersion, mainVersion) < 0) {
      warnings.push(
        `⚠️ 非阻塞提醒：当前工作树版本 ${currentVersion} 低于 ${mainRef || 'origin/main'}（${mainVersion}），合入前请先 rebase ${mainRef || 'origin/main'} 并递增至 ${nextVersion}。`,
      )
    } else if (npmLatest && compareSemver(currentVersion, npmLatest) <= 0) {
      warnings.push(
        `⚠️ 非阻塞提醒：当前工作树版本 ${currentVersion} 未高于 npm 已发布版本 ${npmLatest}，请顺延递增至 ${nextVersion}。`,
      )
    }
    if (currentLockVersion && currentLockVersion !== currentVersion) {
      warnings.push(
        `⚠️ 非阻塞提醒：当前工作树 package.json（${currentVersion}）与 package-lock.json（${currentLockVersion}）版本不一致，提交前请同步更新。`,
      )
    }
  }

  if (currentVersion) {
    for (const other of activeSlotVersions) {
      if (normalizePath(other.path) === normTarget) continue
      if (other.version && other.version === currentVersion) {
        warnings.push(
          `⚠️ 非阻塞提醒：当前工作树版本 ${currentVersion} 与【${other.slot} 号工位】（分支 ${other.branch || '-'}）重复，请按顺序合并并在需要时顺延至 ${nextVersion}。`,
        )
      }
    }
  }

  const slotsByVersion = new Map()
  for (const s of activeSlotVersions) {
    if (!s.version) continue
    const list = slotsByVersion.get(s.version) || []
    list.push(s)
    slotsByVersion.set(s.version, list)
  }
  for (const [ver, group] of slotsByVersion.entries()) {
    if (group.length < 2) continue
    const involvesCurrentOnly =
      currentSlot && group.length === 2 && group.some((g) => Number(g.slot) === Number(currentSlot.slot))
    if (involvesCurrentOnly) continue
    const labels = group.map((g) => `【${g.slot} 号工位】`).join('、')
    warnings.push(
      `⚠️ 非阻塞提醒：工位版本撞号（${ver}）：${labels} 当前版本相同，请按顺序合并后分别顺延递增。`,
    )
  }

  return {
    latestTag: latestTagInfo?.tag || null,
    tagVersion: latestTagInfo?.version || null,
    latestLocalTag: latestLocalTagInfo?.tag || null,
    remoteLatestTag: remoteLatestTagInfo?.tag || null,
    npmLatest,
    npmChecked: Boolean(checkRemote && !offline),
    mainRef,
    mainVersion,
    queuedVersions,
    queuedCommits,
    activeSlotVersions,
    occupiedVersions,
    nextVersion,
    currentVersion,
    currentLockVersion,
    currentBranch,
    currentSlotNumber: currentSlot?.slot || null,
    warnings,
  }
}

export function formatVersionQueueLines(queueInfo, { detailed = false } = {}) {
  if (!queueInfo) return []
  const tagLabel = queueInfo.latestTag ? `${queueInfo.latestTag}（${queueInfo.tagVersion}）` : '暂无发版 tag'
  const npmPart = queueInfo.npmLatest
    ? `npm latest: ${queueInfo.npmLatest}`
    : queueInfo.npmChecked
      ? 'npm latest: 未取到（离线或超时已跳过）'
      : 'npm latest: 本地模式未查'
  const mainLabel = `${queueInfo.mainRef || 'origin/main'}: ${queueInfo.mainVersion || '未知'}`
  const queuedLabel = queueInfo.queuedVersions.length ? queueInfo.queuedVersions.join('、') : '暂无'
  const slotOccupiedList = queueInfo.activeSlotVersions
    .filter((s) => s.version)
    .map((s) => `${s.slot}号:${s.version}`)

  if (!detailed) {
    const slotPart = slotOccupiedList.length ? ` ｜ 活跃工位版本 ${slotOccupiedList.join('、')}` : ''
    const lines = [
      `版本排队提醒：已发版 ${queueInfo.latestTag || '无'} ｜ ${mainLabel} ｜ 待发队列 ${queuedLabel}${slotPart} ｜ 下一可用 ${queueInfo.nextVersion}（详情: node scripts/worktree-slots.mjs queue）`,
    ]
    return [...lines, ...queueInfo.warnings]
  }

  const lines = [
    `版本排队与基线检查（非阻塞 · 一个 PR 一个独立版本）：`,
    `- 已发版基线：${tagLabel} ｜ ${npmPart}`,
    `- 主干基线：${mainLabel}`,
    `- 自最近发版 tag 以来待发版队列：${queuedLabel}（共 ${queueInfo.queuedCommits.length} 个提交）`,
  ]
  for (const commit of queueInfo.queuedCommits) {
    const verTag = commit.version ? `${commit.version}${commit.bumped ? '' : ' [未改版本号]'}` : '未知版本'
    lines.push(`  · ${verTag} (${commit.shortHash}) ${commit.subject}`)
  }
  if (queueInfo.activeSlotVersions.length) {
    lines.push(`- 活跃工位工作树版本占用：`)
    for (const s of queueInfo.activeSlotVersions) {
      const badges = `${s.frontend ? '🎨' : ''}${s.chore ? '🔧' : ''}`
      lines.push(`  · 【${s.slot} 号工位${badges}】${s.version || '未知'}（分支: ${s.branch || '-'}，目录: ${s.path}）`)
    }
  } else {
    lines.push(`- 活跃工位工作树版本占用：暂无活跃工位`)
  }
  const avoidList = [...new Set([...queueInfo.queuedVersions, ...queueInfo.activeSlotVersions.map((s) => s.version).filter(Boolean)])]
    .sort(compareSemver)
    .join('、')
  lines.push(
    `- 下一可用递增版本：${queueInfo.nextVersion}${avoidList ? `（请勿占用已排队/已占用版本：${avoidList}）` : ''}`,
  )
  for (const warning of queueInfo.warnings) {
    lines.push(`- ${warning}`)
  }
  return lines
}

export function buildWorkerPrompt(entry, bugDetail = '', queueInfo = null) {
  const detail = String(bugDetail || entry.title || '').trim()
  const isFrontend = Boolean(entry.frontend)
  const isChore = Boolean(entry.chore)
  const roleBadges = [isFrontend ? '前端任务 🎨' : '', isChore ? '非业务代码任务 🔧' : ''].filter(Boolean)
  const roleSuffix = roleBadges.length ? `（${roleBadges.join(' · ')}）` : ''
  const pendingReleaseTitle = formatThreadTitle(entry.slot, entry.title, {
    frontend: isFrontend,
    chore: isChore,
    releaseStage: '待发版',
    versionTag: '<版本号>',
  })
  const avoidVersions = queueInfo
    ? [...new Set([...(queueInfo.queuedVersions || []), ...(queueInfo.activeSlotVersions || []).map((s) => s.version).filter(Boolean)])]
        .sort(compareSemver)
    : []
  const nextVerExample = queueInfo?.nextVersion || '<下一个递增版本>'
  const nextPatchHint = parseSemver(nextVerExample)?.patch ?? '<版本号末位>'
  const queueReminderLines = queueInfo
    ? [
        `- 版本排队提醒（一个 PR 一个独立版本，不设免发版特例）：`,
        `  · 已发版基线：${queueInfo.latestTag || '无'} ｜ ${queueInfo.mainRef || 'origin/main'}：${queueInfo.mainVersion || '未知'}`,
        avoidVersions.length ? `  · 已排队/已占用版本号（严禁复用）：${avoidVersions.join('、')}` : '',
        `  · 建议本单递增版本：${nextVerExample}（如合入前 \`origin/main\` 推进，请先 \`rebase\` 并顺延；随时运行 \`node scripts/worktree-slots.mjs queue\` 查看）`,
        ...(queueInfo.warnings || []).map((w) => `  · ${w}`),
      ].filter(Boolean)
    : []
  const titleTagNote = isChore
    ? '如过程中新增了前端改动请补充 `🎨`，不涉及改业务代码保持 `🔧`'
    : '若涉及前端改动保留/补充 `🎨`，不涉及改业务代码可补充 `🔧`'
  return [
    `你已被总管会话分配到 StrataGate 的【${entry.slot} 号工位】${roleSuffix}。`,
    ``,
    `- 你的工位编号：【${entry.slot} 号工位】`,
    `- 你的专属工作树目录：\`${entry.path}\`（所有终端命令、文件读写、测试与打包必须在此目录下执行，严禁修改主目录或其他工位目录）`,
    `- 你的专属 Git 分支：\`${entry.branch}\`（已从 \`origin/main\` 切出）`,
    `- 任务标题：${entry.title}`,
    detail && detail !== entry.title ? `- 详细需求/Bug 描述：\n${detail}` : '',
    ...queueReminderLines,
    ``,
    `执行要求：`,
    `1. 全程在 \`${entry.path}\` 下定位并修复该问题，不要混入其他工位或主目录的改动。`,
    `2. 每次向用户汇报开头第一行必须输出工位状态（可运行 \`node scripts/worktree-slots.mjs status --path "${entry.path}"\` 获取）：\`当前并行工位：共 N 个 ｜ 我是【${entry.slot} 号工位】\`。`,
    `3. 阶段进展变化时，用 \`node scripts/worktree-slots.mjs claim --path "${entry.path}" --slot ${entry.slot} --state "<当前状态>"\` 更新工位状态（如“排查中”、“本地测试通过·待验收”）。`,
    `4. 修复完成后跑通对应单测/检查${isChore && !isFrontend ? '' : '（凡涉及前端或界面展示的改动，必须先打出 `.tgz` 候选包而非正式发布，装入桌面版 DeepSeek Harness，用 computer use 基于有旧数据的非空真实库端到端实测并看图确认；交付用户验收时必须直接展示修改前与修改后的对比截图）'}。本仓库遵循**一个 PR 一个独立版本**（不设免发版特例）与**并行开发、顺序合并**（前面独立同时开发，最后严禁多工位并发合入 \`main\`）：等待用户 \`pass\` 并确认轮到自己顺序合并后，先基于最新 \`origin/main\` 变基并递增 \`package.json\`、\`package-lock.json\`、\`CHANGELOG.md\` 为**全新的独立版本号**（当前建议 \`${nextVerExample}\`，严禁与前序待发版单或其他工位共用同一版本号）再合入 \`main\`，随后执行 \`node scripts/worktree-slots.mjs release ${entry.slot}\` 释放工位，并调用 \`set_thread_title\` 去掉工位号改为 \`${pendingReleaseTitle}\`（\`<版本号>\` 取本单独占的新版本号末位，如 \`${nextPatchHint}\`；正式发版后改为 \`已发版\`；${titleTagNote}）。`,
  ].filter(Boolean).join('\n')
}

function printStatus(registry, currentPath, queueInfo = null) {
  const normCurrent = normalizePath(currentPath)
  const slots = [...(registry.slots || [])].sort((a, b) => Number(a.slot) - Number(b.slot))
  const currentSlot = slots.find((s) => normalizePath(s.path) === normCurrent)
  const versionMap = new Map((queueInfo?.activeSlotVersions || []).map((s) => [Number(s.slot), s.version]))
  const header = currentSlot
    ? `当前并行工位：共 ${slots.length} 个 ｜ 我是【${currentSlot.slot} 号工位】`
    : `当前并行工位：共 ${slots.length} 个 ｜ 当前目录未登记工位`
  console.log(header)
  if (slots.length === 0) {
    console.log('- （暂无登记的并行工位）')
  } else {
    for (const s of slots) {
      const isMe = normalizePath(s.path) === normCurrent
      const badges = `${s.frontend ? '🎨' : ''}${s.chore ? '🔧' : ''}`
      const tag = isMe ? `【${s.slot} 号工位${badges} · 当前】` : `【${s.slot} 号工位${badges}】`
      const slotVer = versionMap.get(Number(s.slot))
      const verPart = slotVer ? `，版本: ${slotVer}` : ''
      const threadPart = s.threadId ? `，会话ID: ${s.threadId}` : ''
      console.log(`- ${tag} ${s.title || '未命名任务'}（分支: ${s.branch || '-'}${verPart}，状态: ${s.state || '进行中'}${threadPart}，目录: ${s.path}）`)
    }
  }
  if (queueInfo) {
    for (const line of formatVersionQueueLines(queueInfo, { detailed: false })) {
      console.log(line)
    }
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const { command, positional, flags } = parseArgs(argv)
  const targetPath = resolve(flags.path || options.cwd || getTopLevel())
  const registry = pruneMissingWorktrees(loadRegistry(targetPath))
  const checkRemote = flags.offline === 'true'
    ? false
    : command === 'queue'
      ? flags.remote !== 'false'
      : flags.remote === 'true' || flags.npm === 'true'

  if (command === 'create' || command === 'new') {
    const slotNumber = flags.slot ? Number(flags.slot) : smallestAvailableSlot(registry.slots)
    const slug = sanitizeSlug(flags.slug || flags.branch || positional[0] || `task-${slotNumber}`)
    const branchName = flags.branch || `codex/${slug}`
    const commonGitDir = getCommonGitDir(targetPath)
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
    const isChore = Boolean(resolveChoreFlag(flags, false))
    const entry = {
      slot: slotNumber,
      title: taskTitle,
      frontend: isFrontend,
      chore: isChore,
      threadTitle: formatThreadTitle(slotNumber, taskTitle, { frontend: isFrontend, chore: isChore }),
      branch: branchName,
      path: worktreePath,
      state: flags.state || '进行中',
      threadId: flags['thread-id'] || flags.threadId || null,
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    registry.slots = registry.slots.filter((s) => Number(s.slot) !== slotNumber && normalizePath(s.path) !== normalizePath(worktreePath))
    registry.slots.push(entry)
    saveRegistry(registry, targetPath)
    const queueInfo = await collectVersionQueue({
      targetPath: worktreePath,
      repoRoot,
      registry,
      checkRemote,
      fetchImpl: options.fetchImpl,
    })
    if (flags.json === 'true') {
      console.log(JSON.stringify({
        projectId: STRATAGATE_PROJECT_ID,
        slot: entry.slot,
        title: entry.title,
        frontend: entry.frontend,
        chore: entry.chore,
        threadTitle: entry.threadTitle,
        branch: entry.branch,
        path: entry.path,
        state: entry.state,
        threadId: entry.threadId,
        queue: queueInfo,
        workerPrompt: buildWorkerPrompt(entry, flags.bug || flags.prompt || '', queueInfo),
        slots: registry.slots,
      }, null, 2))
    } else {
      printStatus(registry, worktreePath, queueInfo)
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
      const isChore = Boolean(resolveChoreFlag(flags, false))
      existing = {
        slot: slotNumber,
        title: taskTitle,
        frontend: isFrontend,
        chore: isChore,
        threadTitle: formatThreadTitle(slotNumber, taskTitle, { frontend: isFrontend, chore: isChore }),
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
      const nextChore = resolveChoreFlag(flags, undefined)
      if (nextChore !== undefined) {
        existing.chore = nextChore
      } else if (existing.chore === undefined) {
        existing.chore = false
      }
      if (flags.title || positional.length) {
        existing.title = flags.title || positional.join(' ')
      }
      existing.threadTitle = formatThreadTitle(existing.slot, existing.title, {
        frontend: Boolean(existing.frontend),
        chore: Boolean(existing.chore),
      })
      if (flags.state) existing.state = flags.state
      if (flags['thread-id'] || flags.threadId) existing.threadId = flags['thread-id'] || flags.threadId
      existing.branch = flags.branch || getBranch(targetPath)
      existing.updatedAt = new Date().toISOString()
    }
    saveRegistry(registry, targetPath)
    const queueInfo = await collectVersionQueue({ targetPath, registry, checkRemote, fetchImpl: options.fetchImpl })
    if (flags.json === 'true') {
      console.log(JSON.stringify({ projectId: STRATAGATE_PROJECT_ID, queue: queueInfo, slots: registry.slots }, null, 2))
    } else {
      printStatus(registry, targetPath, queueInfo)
    }
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
    const nextChore = resolveChoreFlag(flags, undefined)
    if (nextChore !== undefined) {
      target.chore = nextChore
    } else if (target.chore === undefined) {
      target.chore = false
    }
    if (flags.title) {
      target.title = flags.title
    }
    target.threadTitle = formatThreadTitle(target.slot, target.title, {
      frontend: Boolean(target.frontend),
      chore: Boolean(target.chore),
    })
    target.updatedAt = new Date().toISOString()
    saveRegistry(registry, target.path)
    const queueInfo = await collectVersionQueue({ targetPath: target.path, registry, checkRemote, fetchImpl: options.fetchImpl })
    printStatus(registry, target.path, queueInfo)
  } else if (command === 'release') {
    const slotArg = positional[0] ? Number(positional[0]) : (flags.slot ? Number(flags.slot) : null)
    const normTarget = normalizePath(targetPath)
    const beforeCount = registry.slots.length
    registry.slots = registry.slots.filter((s) => {
      if (slotArg !== null && Number.isInteger(slotArg)) return Number(s.slot) !== slotArg
      return normalizePath(s.path) !== normTarget
    })
    saveRegistry(registry, targetPath)
    const queueInfo = await collectVersionQueue({ targetPath, registry, checkRemote, fetchImpl: options.fetchImpl })
    console.log(`已释放工位（移除 ${beforeCount - registry.slots.length} 个），剩余并行工位 ${registry.slots.length} 个。`)
    printStatus(registry, targetPath, queueInfo)
  } else if (command === 'queue') {
    const queueInfo = await collectVersionQueue({ targetPath, registry, checkRemote, fetchImpl: options.fetchImpl })
    if (flags.json === 'true') {
      console.log(JSON.stringify({ projectId: STRATAGATE_PROJECT_ID, queue: queueInfo, slots: registry.slots }, null, 2))
    } else {
      for (const line of formatVersionQueueLines(queueInfo, { detailed: true })) {
        console.log(line)
      }
    }
  } else {
    try {
      saveRegistry(registry, targetPath)
    } catch {
      // ignore write error on read-only status checks
    }
    const queueInfo = await collectVersionQueue({ targetPath, registry, checkRemote, fetchImpl: options.fetchImpl })
    if (flags.json === 'true') {
      console.log(JSON.stringify({ projectId: STRATAGATE_PROJECT_ID, queue: queueInfo, slots: registry.slots }, null, 2))
    } else {
      printStatus(registry, targetPath, queueInfo)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
