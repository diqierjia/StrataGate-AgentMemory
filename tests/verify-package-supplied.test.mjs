import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
test('checks and preserves the supplied tarball and rejects a different version', () => {
  const temp = mkdtempSync(join(tmpdir(), 'package-check-test-'))
  try {
    const pack = join(temp, 'package')
    mkdirSync(pack)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const paths = ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'docs/DSH.md', 'docs/DSH.zh-CN.md', 'screenshots.json', 'CHANGELOG.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/plugin.js', 'dist/repair-profile.js', 'dist/client.js', 'dist/client.d.ts']
    for (const file of paths) {
      const path = join(pack, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file === 'package.json' ? JSON.stringify(manifest) : '')
    }
    const npmMock = join(temp, 'npm-mock.cjs')
    writeFileSync(npmMock, `const fs = require('node:fs'); const cp = require('node:child_process'); const path = require('node:path'); if (process.argv[2] === 'install') { const dest = path.join(process.cwd(), 'node_modules', 'stratagate-dsh'); fs.mkdirSync(dest, {recursive:true}); const r = cp.spawnSync('tar', ['-xzf', process.argv[3], '-C', dest, '--strip-components=1'], {stdio:'inherit'}); process.exit(r.status); }`)
    const tarball = join(temp, 'candidate.tgz')
    const build = () => assert.equal(spawnSync('tar', ['-czf', tarball, '-C', temp, 'package']).status, 0)
    const verify = () => spawnSync(process.execPath, [join(root, 'scripts/verify-package.mjs'), tarball], { cwd: root, encoding: 'utf8', env: { ...process.env, npm_execpath: npmMock, DSH_VERSION: '' } })
    build()
    const result = verify()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(tarball), true)
    manifest.version = '0.0.0-mismatch'
    writeFileSync(join(pack, 'package.json'), JSON.stringify(manifest))
    build()
    const mismatch = verify()
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /does not match source/)
    assert.equal(existsSync(tarball), true)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
