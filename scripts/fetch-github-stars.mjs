// Fetch the repository star count at build/prepack time and cache it in a
// generated JSON file. Any failure (offline, rate limit, GitHub 5xx) keeps the
// previous value so a package build never fails because of decoration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const target = new URL('src/github-stars.json', root)
const repository = 'diqierjia/StrataGate-AgentMemory'
const fallback = 128

function readPrevious() {
  try {
    if (!existsSync(target)) return { count: fallback, updatedAt: null }
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    return Number.isSafeInteger(parsed?.count) && parsed.count >= 0
      ? { count: parsed.count, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null }
      : { count: fallback, updatedAt: null }
  } catch {
    return { count: fallback, updatedAt: null }
  }
}

async function fetchCount() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'stratagate-build' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
    const data = await response.json()
    const count = data?.stargazers_count
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('GitHub API returned no stargazers_count')
    return count
  } finally {
    clearTimeout(timer)
  }
}

const previous = readPrevious()
let next = previous
try {
  next = { count: await fetchCount(), updatedAt: new Date().toISOString() }
  console.log(`StrataGate stars: ${next.count}`)
} catch (error) {
  console.warn(`StrataGate star fetch failed, keeping ${previous.count}: ${error instanceof Error ? error.message : String(error)}`)
}
writeFileSync(target, JSON.stringify(next, null, 2) + '\n')
console.log(fileURLToPath(target))
