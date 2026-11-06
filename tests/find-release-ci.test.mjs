import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findReusableRun, hasRequiredJobs, main } from '../scripts/find-release-ci.mjs'

const good = { id: 1, run_attempt: 2, head_sha: 'abc', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', html_url: 'https://example.test/run' }
const jobs = ['classify', 'core (22.19.0)', 'core (24.x)', ...['ubuntu-latest', 'windows-latest'].flatMap(os => ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.2-rc.1'].map(host => `dsh-compatibility (${os}, ${host})`))].map(name => ({ name, status: 'completed', conclusion: 'success' }))
const ubuntuJobs = jobs.filter(job => !job.name.includes('windows-latest'))
const env = { GITHUB_SHA: 'abc', GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'token' }

test('requires the exact successful main push and the required matrix jobs', () => {
  assert.equal(findReusableRun([good], 'abc'), good)
  for (const change of [{ head_sha: 'other' }, { head_branch: 'other' }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }, { path: '.github/workflows/other.yml' }]) assert.equal(findReusableRun([{ ...good, ...change }], 'abc'), undefined)
  assert.equal(hasRequiredJobs(jobs), true)
  assert.equal(hasRequiredJobs(ubuntuJobs, { requireWindows: false }), true)
  assert.equal(hasRequiredJobs(ubuntuJobs), false)
  assert.equal(hasRequiredJobs(jobs.slice(1)), false)
  assert.equal(hasRequiredJobs(jobs.map((j, i) => i ? j : { ...j, conclusion: 'skipped' })), false)
})

test('checks the matching run attempt and fails closed on unavailable evidence', async () => {
  const request = async url => url.includes('/attempts/2/jobs?')
    ? { ok: true, json: async () => ({ jobs }) }
    : { ok: true, json: async () => ({ workflow_runs: [good] }) }
  assert.equal(await main(env, request), true)
  await assert.rejects(main(env, async () => ({ ok: false, status: 403 })), /403/)
  await assert.rejects(main(env, async () => { throw new Error('offline') }), /offline/)
  await assert.rejects(main(env, async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })), /No completed/)
  await assert.rejects(main(env, async url => url.includes('/attempts/') ? { ok: true, json: async () => ({ jobs: jobs.slice(1) }) } : { ok: true, json: async () => ({ workflow_runs: [good] }) }), /Required CI jobs/)
  await assert.rejects(main({}, request), /missing GitHub context/)
})
