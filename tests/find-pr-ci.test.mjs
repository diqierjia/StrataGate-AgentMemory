import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPrCi, main } from '../scripts/find-pr-ci.mjs'
import { main as findReleaseCi } from '../scripts/find-release-ci.mjs'

const env = { GITHUB_SHA: 'merge', GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'token' }
const jobs = ['reuse-pr-ci', 'classify', 'core (22.19.0)', 'core (24.x)', ...['ubuntu-latest', 'windows-latest'].flatMap(os => ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.2-rc.1'].map(host => `dsh-compatibility (${os}, ${host})`))].map(name => ({ name, status: 'completed', conclusion: 'success' }))
const pr = { number: 1, merged_at: 'now', merge_commit_sha: 'merge', base: { ref: 'main' }, head: { sha: 'head', repo: { full_name: 'owner/repo' } } }
const run = { id: 1, run_attempt: 1, event: 'pull_request', head_sha: 'head', head_repository: { full_name: 'owner/repo' }, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'test' }
function api({ mergeTree = 'tree', headTree = 'tree', pull = pr, ci = run, ciJobs = jobs, files = [{ filename: 'src/runtime.ts' }] } = {}) {
  return async url => {
    let value
    if (url.includes('/commits/merge/pulls?')) value = [pull]
    else if (url.endsWith('/commits/merge')) value = { commit: { tree: { sha: mergeTree } } }
    else if (url.endsWith('/commits/head')) value = { commit: { tree: { sha: headTree } } }
    else if (url.includes('/pulls/1/files?')) value = files
    else if (url.includes('/actions/workflows/')) value = { workflow_runs: [ci] }
    else if (url.includes('/attempts/1/jobs?')) value = { jobs: ciJobs }
    else throw new Error(`unexpected URL ${url}`)
    return { ok: true, json: async () => value }
  }
}
test('reuses only complete successful same-tree PR CI from this repository', async () => {
  assert.equal(await findPrCi(env, api()), run)
  for (const options of [
    { headTree: 'other' }, { pull: { ...pr, merged_at: null } }, { pull: { ...pr, merge_commit_sha: 'other' } },
    { pull: { ...pr, head: { ...pr.head, repo: { full_name: 'other/fork' } } } },
    { ci: { ...run, conclusion: 'failure' } }, { ci: { ...run, status: 'in_progress' } },
    { ci: { ...run, path: 'other' } }, { ciJobs: jobs.slice(1) },
    { ciJobs: jobs.map((j, i) => i ? j : { ...j, conclusion: 'skipped' }) },
  ]) assert.equal(await findPrCi(env, api(options)), undefined)
})
test('standard PR evidence accepts Ubuntu only; high-risk and release require Windows', async () => {
  const ubuntuJobs = jobs.filter(job => !job.name.includes('windows-latest'))
  assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'src/client.js' }] })), run)
  assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'src/runtime.ts' }] })), undefined)
  assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'src/client.js' }] }), { requireWindows: true }), undefined)
})
test('API errors fall back to full main CI', async () => {
  assert.equal(await main(env, async () => { throw new Error('offline') }), false)
})
test('release accepts same-tree PR evidence and rejects changed-tree evidence', async () => {
  assert.equal(await findReleaseCi(env, api()), true)
  await assert.rejects(findReleaseCi(env, api({ headTree: 'changed' })))
})
