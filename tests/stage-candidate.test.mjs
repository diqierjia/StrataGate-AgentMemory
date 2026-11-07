import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertCandidateVersion, rewritePackageVersions } from '../scripts/stage-candidate.mjs'

test('candidate version is derived from the formal source version', () => {
  assert.equal(assertCandidateVersion('0.3.42', '0.3.42-candidate.1'), 1)
  assert.throws(() => assertCandidateVersion('0.3.42-candidate.1', '0.3.42-candidate.2'), /正式三段版本/)
  assert.throws(() => assertCandidateVersion('0.3.42', '0.3.43-candidate.1'), /必须基于源码版本/)
  assert.throws(() => assertCandidateVersion('0.3.42', '0.3.42.1'), /形如/)
})

test('candidate metadata is rewritten only in the staging copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-meta-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'stratagate-dsh', version: '0.3.42' }))
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.3.42', packages: { '': { version: '0.3.42' } } }))
    rewritePackageVersions(root, '0.3.42-candidate.1')
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.3.42-candidate.1')
    assert.equal(JSON.parse(readFileSync(join(root, 'package-lock.json'))).packages[''].version, '0.3.42-candidate.1')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
