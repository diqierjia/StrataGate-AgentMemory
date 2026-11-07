import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Paths exercised by check:dsh, test:dsh, build:dsh, or verify:dsh.
// Version-only manifest edits are handled separately so a formal version bump
// does not by itself demand Windows.
const HIGH_RISK_PATTERNS = [
  /^\.github\/workflows\//,
  /^src\//,
  /^tests\/fixtures\//,
  /^tests\/.*\.ts$/,
  /^packages\/core\/src\//,
  /^packages\/core\/package\.json$/,
  /^packages\/core\/tsconfig(?:\.build)?\.json$/,
  /^scripts\/(?:run-dsh-compatibility|dsh-cli-isolate|build-client|check-feedback-policy|verify-package|verify-dsh-install)\.mjs$/,
  /^(?:tsconfig(?:\.base)?\.json|vitest\.config\.ts|tsup\.config\.ts|cordis\.patch\.yml)$/,
  /^(?:pnpm-lock\.yaml|yarn\.lock)$/,
]

const VERSION_METADATA_FILES = new Set(['package.json', 'package-lock.json'])

export function diffTouchesOnlyVersionMetadata(patch) {
  if (typeof patch !== 'string' || patch.trim() === '') return false
  const changes = patch.split(/\r?\n/).filter(line => /^[+-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---'))
  if (changes.length === 0 || changes.length > 4) return false
  return changes.every(line => /^[+-]\s*"version"\s*:/.test(line))
}

export function requiresWindows(paths, diffsByPath = undefined) {
  return paths.some(path => {
    const normalized = path.replaceAll('\\', '/')
    if (VERSION_METADATA_FILES.has(normalized)) {
      if (!diffsByPath || !Object.hasOwn(diffsByPath, normalized)) return true
      return !diffTouchesOnlyVersionMetadata(diffsByPath[normalized])
    }
    return HIGH_RISK_PATTERNS.some(pattern => pattern.test(normalized))
  })
}

export function classifyPaths(paths, diffsByPath = undefined) {
  const normalized = paths.map(path => path.replaceAll('\\', '/')).filter(Boolean)
  const runWindows = requiresWindows(normalized, diffsByPath)
  return {
    runWindows,
    osMatrix: runWindows ? ['ubuntu-latest', 'windows-latest'] : ['ubuntu-latest'],
    paths: normalized,
    classificationError: false,
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) })
}

function changedPaths(base, head, cwd) {
  return git(['diff', '--name-only', `${base}...${head}`], cwd).split(/\r?\n/).filter(Boolean)
}

function manifestDiffs(base, head, paths, cwd) {
  const diffs = {}
  for (const path of paths) {
    const normalized = path.replaceAll('\\', '/')
    if (!VERSION_METADATA_FILES.has(normalized)) continue
    diffs[normalized] = git(['diff', '--unified=3', `${base}...${head}`, '--', path], cwd)
  }
  return diffs
}

export function main(env = process.env, { cwd } = {}) {
  const event = env.GITHUB_EVENT_NAME || 'pull_request'
  let result
  try {
    const paths = event === 'pull_request' ? changedPaths(env.BASE_SHA, env.HEAD_SHA, cwd) : []
    // A direct push to main has no PR diff to classify. Fail closed and run
    // Windows unless CI can reuse a completed PR run for the exact tree.
    result = event === 'pull_request'
      ? classifyPaths(paths, manifestDiffs(env.BASE_SHA, env.HEAD_SHA, paths, cwd))
      : { runWindows: true, osMatrix: ['ubuntu-latest', 'windows-latest'], paths, classificationError: false }
  } catch (error) {
    result = { runWindows: true, osMatrix: ['ubuntu-latest', 'windows-latest'], paths: [], classificationError: true, error }
    console.warn(`CI risk classification failed; defaulting to high risk: ${error.message}`)
  }
  const output = [
    `run_windows=${result.runWindows}`,
    `os_matrix=${JSON.stringify(result.osMatrix)}`,
    `risk=${result.runWindows ? 'high' : 'standard'}`,
    `classification_error=${result.classificationError}`,
  ].join('\n') + '\n'
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, output)
  console.log(`CI risk: ${result.runWindows ? 'high' : 'standard'}; Windows: ${result.runWindows ? 'enabled' : 'skipped'}`)
  if (result.paths.length) console.log(`Changed paths: ${result.paths.join(', ')}`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
