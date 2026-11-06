import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HIGH_RISK_PATTERNS = [
  /^\.github\/workflows\//,
  /^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /^scripts\//,
  /^packages\//,
  /^src\/(?:runtime|storage|llm|dsh-compatibility|server|host|process|sqlite)[^/]*\./,
  /^tests\/(?:dsh-|.*(?:compatibility|install|migration|runtime|storage|background-worker|process|sqlite)[^/]*)\./,
]

export function requiresWindows(paths) {
  return paths.some(path => HIGH_RISK_PATTERNS.some(pattern => pattern.test(path.replaceAll('\\', '/'))))
}

export function classifyPaths(paths) {
  const normalized = paths.map(path => path.replaceAll('\\', '/')).filter(Boolean)
  const runWindows = requiresWindows(normalized)
  return {
    runWindows,
    osMatrix: runWindows ? ['ubuntu-latest', 'windows-latest'] : ['ubuntu-latest'],
    paths: normalized,
    classificationError: false,
  }
}

function changedPaths(base, head) {
  return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
}

export function main(env = process.env) {
  const event = env.GITHUB_EVENT_NAME || 'pull_request'
  let result
  try {
    const paths = event === 'pull_request' ? changedPaths(env.BASE_SHA, env.HEAD_SHA) : []
    // A direct push to main has no PR risk classification. Fail closed and run
    // Windows unless CI can reuse a completed PR run for the exact tree.
    result = event === 'pull_request'
      ? classifyPaths(paths)
      : { runWindows: true, osMatrix: ['ubuntu-latest', 'windows-latest'], paths, classificationError: false }
  } catch (error) {
    // A classifier failure must never silently remove Windows coverage.
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
