import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPaths, main, requiresWindows } from '../scripts/classify-ci-risk.mjs'

test('standard changes keep the fast Ubuntu-only DSH matrix', () => {
  assert.equal(requiresWindows(['src/client.js', 'docs/development-validation.md']), false)
  assert.deepEqual(classifyPaths(['src/client.js']).osMatrix, ['ubuntu-latest'])
})

test('host and release-sensitive changes enable Windows', () => {
  for (const path of [
    'src/runtime.ts',
    'src/storage.ts',
    'src/llm-client.ts',
    'scripts/run-dsh-compatibility.mjs',
    '.github/workflows/ci.yml',
    'package.json',
    'package-lock.json',
    'tests/dsh-install-script.test.ts',
  ]) assert.equal(requiresWindows([path]), true, path)
  assert.deepEqual(classifyPaths(['src/runtime.ts']).osMatrix, ['ubuntu-latest', 'windows-latest'])
})

test('path matching is normalized and does not trust commit text', () => {
  assert.equal(requiresWindows(['src\\runtime.ts']), true)
  assert.equal(requiresWindows(['docs/windows-install.md']), false)
})

test('classifier failure fails closed to the Windows matrix', () => {
  const result = main({ GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: 'missing', HEAD_SHA: 'missing' })
  assert.equal(result.classificationError, true)
  assert.deepEqual(result.osMatrix, ['ubuntu-latest', 'windows-latest'])
})
