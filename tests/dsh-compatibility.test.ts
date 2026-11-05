import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import {
  buildDshReplaceSurfaceOp,
  buildDshMessageSource,
  assertCompatibleDshRuntime,
  classifyDshRuntime,
  assertDshHostContract,
  type DshRuntimePackageVersions,
} from '../src/dsh-compatibility.js'

const common = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/schemastery': '3.18.2',
} as const

function versions(version: string): DshRuntimePackageVersions {
  return {
    ...common,
    ...(!['0.1.2-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1'].includes(version)
      ? { '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/schemastery': '3.18.4' } : {}),
    '@deepseek-ai/dsh-agent-default-model': version,
    '@deepseek-ai/dsh-client-ui-conversation': version,
    '@deepseek-ai/dsh-llm': version,
    '@deepseek-ai/dsh-native-command': version,
    '@deepseek-ai/dsh-session': version,
    '@deepseek-ai/dsh-session-format': version === '0.1.2-rc.1' ? '<missing>' : version,
    '@deepseek-ai/dsh-session-format-catalog': version === '0.1.2-rc.1' ? '<missing>' : version,
    '@deepseek-ai/dsh-session-format-v0-to-v1': version === '0.1.2-rc.1' ? '<missing>' : version,
    '@deepseek-ai/dsh-settings': version,
    '@deepseek-ai/dsh-system-prompt': version,
    '@deepseek-ai/dsh-tools': version,
  }
}

describe('DSH runtime compatibility', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  it.each(['0.2.0-alpha.1', '0.2.0-alpha.99', '0.2.0-beta.3', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.99', '0.2.0', '0.2.0+build.1', '0.2.1-rc.1', '0.2.1', '0.2.2-beta.1', '0.2.99', '0.2.99+build.1'])('passes the real host installation check for DSH %s', (version) => {
    expect(evaluatePluginCompatibility(manifest, {}, version)).toBeUndefined()
  })

  it.each(['0.1.1', '0.1.3', '0.1.5-rc.1'])('fails the real host installation check below the supported DSH baseline: %s', (version) => {
    // Exercise the peer fallback used by older hosts even when engines.dsh exists.
    const rejected = evaluatePluginCompatibility({ ...manifest, engines: { node: manifest.engines.node } }, {}, version)
    expect(rejected?.runtimeVersion).toBe(version)
    const requirements = Reflect.get(rejected!, 'peers') ?? Reflect.get(rejected!, 'requirements')
    expect(Object.keys(requirements)).toHaveLength(11)
  })

  it.each(['0.3.0-0', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '0.4.0', '1.0.0', '2.0.0-rc.1'])('rejects unverified API generations at installation and startup: %s', (version) => {
    expect(evaluatePluginCompatibility(manifest, {}, version)?.runtimeVersion).toBe(version)
    expect(() => classifyDshRuntime(versions(version))).toThrow(/unsupported or mixed core runtime/)
  })

  it('uses bounded continuous ranges for peer declarations and keeps the lockfile in sync', () => {
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
    expect(lock.packages[''].peerDependencies).toEqual(manifest.peerDependencies)
    expect(lock.packages[''].engines).toEqual(manifest.engines)
    expect(manifest.engines.dsh).toBe('0.1.2-rc.1 || >=0.1.5-rc.1 <0.3.0-0')
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      expect(range).toBe(name.startsWith('@deepseek-ai/dsh-session-format')
        ? '>=0.1.5-rc.2 <0.3.0-0' : '0.1.2-rc.1 || >=0.1.5-rc.2 <0.3.0-0')
    }
  })

  it.each(['0.1.2-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7'])('preserves supported peer ranges for DSH %s', (version) => {
    // Session-format packages did not exist in the supported 0.1.2 host.
    const peers = Object.fromEntries(Object.entries(manifest.peerDependencies).filter(([name]) => version !== '0.1.2-rc.1' || !name.startsWith('@deepseek-ai/dsh-session-format')))
    expect(evaluatePluginCompatibility({ ...manifest, peerDependencies: peers }, {}, version)).toBeUndefined()
  })

  it('accepts the complete 0.1.2 host family', () => {
    expect(classifyDshRuntime(versions('0.1.2-rc.1')).cliVersion).toBe('0.1.2-rc.1')
  })

  it('accepts the real 0.1.5-rc.1 dependency tree at rc.2', () => {
    expect(classifyDshRuntime(versions('0.1.5-rc.2')).cliVersion).toBe('0.1.5-rc.1')
  })

  it('accepts the complete 0.1.6-alpha.1 host family', () => {
    expect(classifyDshRuntime(versions('0.1.6-alpha.1')).cliVersion).toBe('0.1.6-alpha.1')
  })

  it('accepts the actual 0.1.7-rc.1 host family', () => {
    expect(classifyDshRuntime(versions('0.1.7-rc.1')).cliVersion).toBe('0.1.7-rc.1')
  })

  it('accepts the actual 0.1.7-rc.2 host family', () => {
    expect(classifyDshRuntime(versions('0.1.7-rc.2')).cliVersion).toBe('0.1.7-rc.2')
  })

  it('accepts a coherent later 0.1.7 host with compatible Cordis and Schemastery patches', () => {
    const future = {
      ...versions('0.1.7-rc.3'),
      '@deepseek-ai/cordis': '4.0.5',
      '@deepseek-ai/schemastery': '3.18.5',
    }
    expect(classifyDshRuntime(future).cliVersion).toBe('0.1.7-rc.3')
    expect(classifyDshRuntime(versions('0.1.7')).cliVersion).toBe('0.1.7')
  })

  it('accepts a later DSH patch while rejecting a mixed future runtime', () => {
    expect(classifyDshRuntime(versions('0.1.8')).cliVersion).toBe('0.1.8')
    const mixed = { ...versions('0.1.7-rc.3'), '@deepseek-ai/dsh-tools': '0.1.7-rc.2' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
  })

  it.each(['0.2.0-0', '0.2.0-alpha.1', '0.2.0-alpha.99', '0.2.0-beta.3', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.99', '0.2.0', '0.2.0+build.1', '0.2.0-alpha.1+build.2', '0.2.1-alpha.1', '0.2.1-rc.1', '0.2.1', '0.2.2-beta.1', '0.2.99', '0.2.99+build.1'])('accepts the complete coherent DSH %s family', (version) => {
    expect(classifyDshRuntime(versions(version)).cliVersion).toBe(version)
  })

  it.each(['0.1.1', '0.1.3', '0.1.5-rc.1', '<missing>', '0.2.0-', '0.2.0-alpha..1', '0.2.0-alpha.01', '0.2.0+', '0.2.0+build..1', '00.2.1'])('rejects unsupported or malformed DSH %s', (version) => {
    expect(() => classifyDshRuntime(versions(version))).toThrow(/unsupported or mixed core runtime/)
  })

  it('keeps DSH 0.2.0 core versions coherent and requires compatible vendor patches', () => {
    expect(classifyDshRuntime({ ...versions('0.2.0-rc.99'), '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/schemastery': '3.18.5' }).cliVersion).toBe('0.2.0-rc.99')
    for (const change of [
      { '@deepseek-ai/dsh-tools': '0.2.0-rc.1' },
      { '@deepseek-ai/dsh-native-command': '0.1.7-rc.2' },
      { '@deepseek-ai/dsh-session': '<missing>' },
      { '@deepseek-ai/cordis': '4.0.3' },
      { '@deepseek-ai/cordis': '4.1.0' },
      { '@deepseek-ai/schemastery': '3.18.3' },
      { '@deepseek-ai/schemastery': '3.19.0' },
    ]) {
      expect(() => classifyDshRuntime({ ...versions('0.2.0-rc.2'), ...change })).toThrow(/unsupported or mixed core runtime/)
    }
  })

  const sessionFormatPackages = [
    '@deepseek-ai/dsh-session-format',
    '@deepseek-ai/dsh-session-format-catalog',
    '@deepseek-ai/dsh-session-format-v0-to-v1',
  ] as const

  it('includes installed Session Format peers in the runtime compatibility report', () => {
    const installed = assertCompatibleDshRuntime()
    for (const name of sessionFormatPackages) {
      expect(installed.packageVersions[name]).toBeTypeOf('string')
      if (!installed.cliVersion.startsWith('0.1.')) {
        expect(installed.packageVersions[name]).toBe(installed.packageVersions['@deepseek-ai/dsh-session'])
      }
    }
  })

  it.each(sessionFormatPackages)('rejects mixed Session Format peer %s on newer hosts', (name) => {
    for (const version of ['0.2.0-rc.2', '0.1.7-rc.2']) {
      const mixed = { ...versions('0.2.1-rc.1'), [name]: version }
      expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
      expect(() => classifyDshRuntime(mixed)).toThrow(`${name}@${version}`)
    }
  })

  it.each(sessionFormatPackages)('rejects a missing Session Format peer %s on newer hosts', (name) => {
    const missing = { ...versions('0.2.1-rc.1'), [name]: '<missing>' }
    expect(() => classifyDshRuntime(missing)).toThrow(`${name}@<missing>`)
    const omitted: Partial<DshRuntimePackageVersions> = { ...versions('0.2.1-rc.1') }
    delete omitted[name]
    expect(() => classifyDshRuntime(omitted as DshRuntimePackageVersions)).toThrow(/unsupported or mixed core runtime/)
  })

  it.each(['0.1.2-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7-rc.3', '0.1.7'])('preserves older runtime rules when Session Format peers are absent on DSH %s', (version) => {
    const older = {
      ...versions(version),
      ...Object.fromEntries(sessionFormatPackages.map((name) => [name, '<missing>'])),
    }
    expect(classifyDshRuntime(older).cliVersion).toBe(version === '0.1.5-rc.2' ? '0.1.5-rc.1' : version)
  })

  it('rejects a future runtime with an incompatible Cordis or Schemastery version', () => {
    expect(() => classifyDshRuntime({ ...versions('0.1.7-rc.3'), '@deepseek-ai/cordis': '4.1.0' }))
      .toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime({ ...versions('0.1.7-rc.3'), '@deepseek-ai/schemastery': '3.19.0' }))
      .toThrow(/unsupported or mixed core runtime/)
  })

  it('rejects a 0.1.5-rc.2 dependency family mixed with dsh-session 0.1.2-rc.1', () => {
    const mixed = { ...versions('0.1.5-rc.2'), '@deepseek-ai/dsh-session': '0.1.2-rc.1' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(mixed)).toThrow(/dsh-session@0\.1\.2-rc\.1/)
  })

  it('rejects a mixed 0.1.5/0.1.6 profile-local DSH runtime with a clear diagnostic', () => {
    const mixed = { ...versions('0.1.6-alpha.1'), '@deepseek-ai/dsh-session': '0.1.5-rc.2' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(mixed)).toThrow(/dsh-session@0\.1\.5-rc\.2/)
  })

  it('rejects a host family that is missing a required package', () => {
    const missing = { ...versions('0.1.6-alpha.1'), '@deepseek-ai/dsh-tools': '<missing>' }
    expect(() => classifyDshRuntime(missing)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(missing)).toThrow(/dsh-tools@<missing>/)
  })

  it('rejects a mixed native-command runtime', () => {
    const mixed = { ...versions('0.1.7-rc.2'), '@deepseek-ai/dsh-native-command': '0.1.7-rc.1' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(mixed)).toThrow(/dsh-native-command@0\.1\.7-rc\.1/)
  })

  it('uses the producer-owned source kind from DSH 0.1.7 onward', () => {
    expect(buildDshMessageSource('0.1.6-alpha.1')).toEqual({ kind: 'plugin', plugin: 'stratagate-memory' })
    expect(buildDshMessageSource('0.1.7-rc.1')).toEqual({ kind: 'plugin:stratagate-memory' })
    expect(buildDshMessageSource('0.1.7-rc.2')).toEqual({ kind: 'plugin:stratagate-memory' })
    expect(buildDshMessageSource('0.1.7-rc.3')).toEqual({ kind: 'plugin:stratagate-memory' })
    expect(buildDshMessageSource('0.1.7')).toEqual({ kind: 'plugin:stratagate-memory' })
    expect(buildDshMessageSource('0.1.7-rc.1', 'instructions')).toEqual({ kind: 'plugin:stratagate-memory', form: 'instructions' })
    for (const version of ['0.2.0-alpha.1', '0.2.0-beta.1', '0.2.0-rc.2', '0.2.0', '0.2.0+build.1', '0.2.1-rc.1', '0.2.99']) {
      expect(buildDshMessageSource(version, 'instructions')).toEqual({ kind: 'plugin:stratagate-memory', form: 'instructions' })
    }
  })

  it('uses each host version\'s native surface replacement shape', () => {
    expect(buildDshReplaceSurfaceOp('0.1.2-rc.1', 2, 5)).toEqual({ op: 'replace', start: 2, end: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.5-rc.2', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.6-alpha.1', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.7-rc.1', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.7-rc.2', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
    expect(buildDshReplaceSurfaceOp('0.2.0-rc.2', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
    expect(buildDshReplaceSurfaceOp('0.2.1-rc.1', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
  })
})

describe('DSH host interface preflight', () => {
  function host() {
    return {
      tools: { register: vi.fn(), get: vi.fn() },
      systemPrompt: { section: vi.fn() },
      llm: { stream: vi.fn(), listProviders: vi.fn() },
      agentDefaultModel: { currentSelection: vi.fn() },
    }
  }

  it('accepts supported interfaces without invoking them', () => {
    const ctx = host()
    assertDshHostContract(ctx as unknown as Parameters<typeof assertDshHostContract>[0])
    for (const service of Object.values(ctx)) {
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['tools', 'register'], ['tools', 'get'], ['systemPrompt', 'section'],
    ['llm', 'stream'], ['llm', 'listProviders'], ['agentDefaultModel', 'currentSelection'],
  ] as const)('rejects a missing %s.%s even when package versions are supported', (service, method) => {
    const ctx = host()
    Reflect.set(ctx[service], method, 'changed-interface')
    expect(() => assertDshHostContract(ctx as unknown as Parameters<typeof assertDshHostContract>[0]))
      .toThrow(`${service}.${method}`)
  })
})
