import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPaths, diffTouchesOnlyVersionMetadata, main, requiresWindows } from '../scripts/classify-ci-risk.mjs'

const versionPatch = [
  '@@ -1,3 +1,3 @@',
  ' {',
  '-  "version": "0.3.42",',
  '+  "version": "0.3.43",',
].join('\n')

test('changes outside the DSH compatibility suite stay on Ubuntu', () => {
  for (const path of [
    'docs/development-validation.md',
    'integrations/workbuddy/src/runtime.ts',
    'scripts/stage-candidate.mjs',
    'scripts/find-pr-ci.mjs',
    'scripts/find-release-ci.mjs',
    'packages/core/tests/store.test.ts',
    'tests/find-pr-ci.test.mjs',
  ]) assert.equal(requiresWindows([path]), false, path)
  assert.deepEqual(classifyPaths(['docs/development-validation.md']).osMatrix, ['ubuntu-latest'])
})

test('paths the compatibility suite actually runs require Windows', () => {
  for (const path of [
    'src/index.ts',
    'src/tools.ts',
    'src/bootstrap.ts',
    'src/client.js',
    'src/dsh-host-resolution.ts',
    'src/runtime.ts',
    'packages/core/src/sqlite.ts',
    'packages/core/package.json',
    'tests/runtime.test.ts',
    'tests/dsh-install-script.test.ts',
    'tests/fixtures/clean-session-v0/session.jsonl',
    'scripts/run-dsh-compatibility.mjs',
    'scripts/build-client.mjs',
    'scripts/check-feedback-policy.mjs',
    'scripts/verify-package.mjs',
    'scripts/verify-dsh-install.mjs',
    'vitest.config.ts',
    'tsup.config.ts',
    'tsconfig.json',
    'tsconfig.base.json',
    'cordis.patch.yml',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
  ]) assert.equal(requiresWindows([path]), true, path)
  assert.deepEqual(classifyPaths(['src/index.ts']).osMatrix, ['ubuntu-latest', 'windows-latest'])
})

test('version-only manifest edits stay on Ubuntu and other manifest edits do not', () => {
  const lockPatch = `${versionPatch}\n-      "version": "0.3.42",\n+      "version": "0.3.43",\n`
  assert.equal(diffTouchesOnlyVersionMetadata(versionPatch), true)
  assert.equal(diffTouchesOnlyVersionMetadata(''), false)
  assert.equal(requiresWindows(['package.json', 'package-lock.json'], {
    'package.json': versionPatch,
    'package-lock.json': lockPatch,
  }), false)
  assert.equal(requiresWindows(['package.json'], {
    'package.json': `${versionPatch}\n-    "semver": "^7.8.5",\n+    "semver": "^7.9.0",\n`,
  }), true)
  assert.equal(requiresWindows(['package-lock.json'], {
    'package-lock.json': `${lockPatch}\n-      "integrity": "sha512-old",\n+      "integrity": "sha512-new",\n`,
  }), true)
  assert.equal(requiresWindows(['package.json']), true)
  assert.equal(requiresWindows(['package.json'], {}), true)
})

test('path matching is normalized and does not trust commit text', () => {
  assert.equal(requiresWindows(['src\\index.ts']), true)
  assert.equal(requiresWindows(['docs/windows-install.md']), false)
})

test('the recorded 0.3.42 version bump is not treated as high risk', () => {
  const result = main({ GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: '5adda49^', HEAD_SHA: '5adda49' })
  assert.equal(result.classificationError, false)
  assert.equal(result.runWindows, false)
  assert.deepEqual(result.paths.sort(), ['package-lock.json', 'package.json'])
})

test('direct pushes and classifier failures stay on the Windows matrix', () => {
  const pushed = main({ GITHUB_EVENT_NAME: 'push' })
  assert.equal(pushed.classificationError, false)
  assert.deepEqual(pushed.osMatrix, ['ubuntu-latest', 'windows-latest'])
  const failed = main({ GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: 'missing', HEAD_SHA: 'missing' })
  assert.equal(failed.classificationError, true)
  assert.deepEqual(failed.osMatrix, ['ubuntu-latest', 'windows-latest'])
})
