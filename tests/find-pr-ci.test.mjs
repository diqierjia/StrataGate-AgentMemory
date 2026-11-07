import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPrCi, main } from '../scripts/find-pr-ci.mjs'
import { main as findReleaseCi } from '../scripts/find-release-ci.mjs'

const env = { GITHUB_SHA: 'merge', GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'token' }
const jobs = ['reuse-pr-ci', 'classify', 'core (22.19.0)', 'core (24.x)', ...['ubuntu-latest', 'windows-latest'].flatMap(os => ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.2-rc.1'].map(host => `dsh-compatibility (${os}, ${host})`))].map(name => ({ name, status: 'completed', conclusion: 'success' }))
const pr = { number: 1, merged_at: 'now', merge_commit_sha: 'merge', base: { ref: 'main' }, head: { sha: 'head', repo: { full_name: 'owner/repo' } } }
const run = { id: 1, run_attempt: 1, event: 'pull_request', head_sha: 'head', head_repository: { full_name: 'owner/repo' }, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'test' }
const versionPatch = '@@ -1,3 +1,3 @@\n-  "version": "0.3.42",\n+  "version": "0.3.43",\n'
function api({ mergeTree = 'tree', headTree = 'tree', pull = pr, ci = run, ciJobs = jobs, files = [{ filename: 'src/runtime.ts' }] } = {}) {
  return async url => {
    let value
    if (url.includes('/commits/merge/pulls?')) value = [pull]
    else if (url.endsWith('/commits/merge')) value = { commit: { tree: { sha: mergeTree } } }
    else if (url.endsWith('/commits/head')) value = { commit: { tree: { sha: headTree } } }
    else if (url.includes('/pulls/1/files?')) {
      const page = Number(new URL(url).searchParams.get('page') || '1')
      value = page === 1 ? files : []
    } else if (url.includes('/actions/workflows/')) value = { workflow_runs: [ci] }
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
test('ordinary evidence can omit Windows; suite changes and forced release checks cannot', async () => {
  const ubuntuJobs = jobs.filter(job => !job.name.includes('windows-latest'))
  assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'docs/readme.md' }] })), run)
  assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'scripts/stage-candidate.mjs' }] })), run)
  assert.equal(await findPrCi(env, api({
    ciJobs: ubuntuJobs,
    files: [{ filename: 'package.json', patch: versionPatch }, { filename: 'package-lock.json', patch: `${versionPatch}-      "version": "0.3.42",\n+      "version": "0.3.43",\n` }],
  })), run)
  for (const filename of ['src/index.ts', 'src/tools.ts', 'src/bootstrap.ts', 'src/client.js', 'packages/core/src/sqlite.ts']) {
    assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename }] })), undefined, filename)
  }
  assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'package.json' }] })), undefined)
  assert.equal(await findPrCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'docs/readme.md' }] }), { requireWindows: true }), undefined)
  assert.equal(await findPrCi(env, api({ ciJobs: jobs, files: [{ filename: 'src/index.ts' }] })), run)
})
test('a high-risk file past the first page still requires Windows', async () => {
  const ubuntuJobs = jobs.filter(job => !job.name.includes('windows-latest'))
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ filename: `docs/note-${index}.md` }))
  const request = async url => {
    if (url.includes('/pulls/1/files?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      const value = page === 1 ? firstPage : page === 2 ? [{ filename: 'src/dsh-host-resolution.ts' }] : []
      return { ok: true, json: async () => value }
    }
    return api({ ciJobs: ubuntuJobs, files: [] })(url)
  }
  assert.equal(await findPrCi(env, request), undefined)
  assert.equal(await findPrCi(env, async url => {
    if (url.includes('/pulls/1/files?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      return { ok: true, json: async () => (page === 1 ? firstPage : []) }
    }
    return api({ ciJobs: ubuntuJobs, files: [] })(url)
  }), run)
})
test('API errors fall back to full main CI', async () => {
  assert.equal(await main(env, async () => { throw new Error('offline') }), false)
})
test('release accepts ordinary same-tree evidence and rejects high-risk evidence without Windows', async () => {
  const ubuntuJobs = jobs.filter(job => !job.name.includes('windows-latest'))
  assert.equal(await findReleaseCi(env, api()), true)
  assert.equal(await findReleaseCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'docs/readme.md' }] })), true)
  assert.equal(await findReleaseCi(env, api({ ciJobs: jobs, files: [{ filename: 'src/index.ts' }] })), true)
  await assert.rejects(findReleaseCi(env, api({ headTree: 'changed' })))
  await assert.rejects(findReleaseCi(env, api({ ciJobs: ubuntuJobs, files: [{ filename: 'src/index.ts' }] })))
})
