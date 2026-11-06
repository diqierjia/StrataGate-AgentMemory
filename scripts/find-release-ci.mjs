import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Only a completed successful push to main for the exact release commit is
// trusted. In particular, PR head_sha does not identify the merge checkout.
export function findReusableRun(runs, sha) {
  return runs.find(run => run.head_sha === sha && run.head_branch === 'main' &&
    run.event === 'push' && run.status === 'completed' && run.conclusion === 'success' &&
    run.path === '.github/workflows/ci.yml')
}

export function hasRequiredJobs(jobs) {
  const names = ['core (22.19.0)', 'core (24.x)']
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    for (const host of ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.1-rc.5']) {
      names.push(`dsh-compatibility (${os}, ${host})`)
    }
  }
  return names.every(name => jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success'))
}

export async function main(env = process.env, request = fetch) {
  let run
  {
    if (!env.GITHUB_SHA || !env.GITHUB_REPOSITORY || !env.GH_TOKEN) throw new Error('missing GitHub context')
    const { findPrCi } = await import('./find-pr-ci.mjs')
    try {
      const prRun = await findPrCi(env, request)
      if (prRun) {
        if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'reuse=true\n')
        console.log(`Reusing same-tree PR CI ${prRun.html_url}`)
        return true
      }
    } catch (error) { console.log(`Cannot reuse PR CI: ${error.message}`) }
    const url = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${encodeURIComponent(env.GITHUB_SHA)}&per_page=100`
    const response = await request(url, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data.workflow_runs)) throw new Error('invalid workflow runs response')
    run = findReusableRun(data.workflow_runs, env.GITHUB_SHA)
    if (!run) throw new Error('No completed successful main CI for the exact release commit')
    const jobsResponse = await request(`${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
    if (!jobsResponse.ok) throw new Error(`GitHub jobs API HTTP ${jobsResponse.status}`)
    const jobsData = await jobsResponse.json()
    if (!Array.isArray(jobsData.jobs) || !hasRequiredJobs(jobsData.jobs)) throw new Error('Required CI jobs missing or unsuccessful')
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `reuse=${Boolean(run)}\n`)
  console.log(`Reusing successful main CI ${run.html_url}`)
  return Boolean(run)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
