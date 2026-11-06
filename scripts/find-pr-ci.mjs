import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { hasRequiredJobs } from './find-release-ci.mjs'

export async function findPrCi(env = process.env, request = fetch) {
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY: repo, GH_TOKEN: token } = env
  if (!sha || !repo || !token) throw new Error('missing GitHub context')
  const base = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}`
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  async function get(path) {
    const response = await request(`${base}${path}`, { headers })
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
    return response.json()
  }
  const commit = await get(`/commits/${sha}`)
  const tree = commit?.commit?.tree?.sha
  if (!tree) throw new Error('missing release tree')
  const pulls = await get(`/commits/${sha}/pulls?per_page=100`)
  if (!Array.isArray(pulls)) throw new Error('invalid pull requests response')
  for (const pr of pulls) {
    if (!pr.merged_at || pr.merge_commit_sha !== sha || pr.base?.ref !== 'main' || pr.head?.repo?.full_name !== repo || !pr.head?.sha) continue
    const head = await get(`/commits/${pr.head.sha}`)
    if (head?.commit?.tree?.sha !== tree) continue
    const data = await get(`/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${encodeURIComponent(pr.head.sha)}&per_page=100`)
    if (!Array.isArray(data.workflow_runs)) throw new Error('invalid workflow runs response')
    for (const run of data.workflow_runs) {
      if (run.event !== 'pull_request' || run.head_sha !== pr.head.sha || run.head_repository?.full_name !== repo || run.path !== '.github/workflows/ci.yml' || run.status !== 'completed' || run.conclusion !== 'success') continue
      const result = await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)
      if (Array.isArray(result.jobs) && hasRequiredJobs(result.jobs) && result.jobs.some(job => job.name === 'reuse-pr-ci' && job.status === 'completed' && job.conclusion === 'success')) return run
    }
  }
  return undefined
}

export async function main(env = process.env, request = fetch) {
  let run
  try { run = await findPrCi(env, request) } catch (error) { console.log(`PR evidence unavailable: ${error.message}`) }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `reuse=${Boolean(run)}\n`)
  console.log(run ? `Reusing PR CI ${run.html_url}` : 'No reusable PR CI; running full CI')
  return Boolean(run)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
