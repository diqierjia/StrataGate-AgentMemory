import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { satisfies } from 'semver'

const source = readFileSync(new URL('../scripts/verify-dsh-install.mjs', import.meta.url), 'utf8')
const hostDeclaration = source.match(/const modernHost = [^\r\n]+/)?.[0]
const failureCheck = source.match(/if \([^\r\n]+\) \{\s*await verifyPluginFailureIsDetected\([^\r\n]+\)\s*\}/)?.[0]
if (!hostDeclaration || !failureCheck) throw new Error('DSH install verification host declaration or failure check is missing')

describe('DSH install verification failure probe', () => {
  it.each([
    ['0.1.2-rc.1', false],
    ['0.1.5-rc.1', false],
    ['0.1.6-alpha.1', true],
    ['0.1.7-rc.1', true],
    ['0.1.7-rc.2', true],
    ['0.2.0-alpha.1', true],
    ['0.2.0-rc.1', true],
    ['0.2.0-rc.2', true],
    ['0.2.0', true],
    ['0.2.1-rc.1', true],
    ['0.3.0', true],
  ])('executes the actual script branch for %s without an unbound host flag', async (version, expected) => {
    const calls: unknown[][] = []
    await runInNewContext(`(async () => { ${hostDeclaration}\n${failureCheck} })()`, {
      version, satisfies, cli: 'fixture-cli', root: 'fixture-root', dshEnv: {}, profile: 'fixture-profile',
      verifyPluginFailureIsDetected: async (...args: unknown[]) => { calls.push(args) },
    })
    expect(calls).toHaveLength(expected ? 1 : 0)
    if (expected) expect(calls[0]).toEqual(['fixture-cli', 'fixture-root', {}, version, 'fixture-profile'])
  })
})
