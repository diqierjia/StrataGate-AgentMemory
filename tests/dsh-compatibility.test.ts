import { describe, expect, it } from 'vitest'
import {
  buildDshReplaceSurfaceOp,
  classifyDshRuntime,
  type DshRuntimePackageVersions,
} from '../src/dsh-compatibility.js'

const common = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/schemastery': '3.18.2',
} as const

function versions(version: '0.1.2-rc.1' | '0.1.5-rc.2'): DshRuntimePackageVersions {
  return {
    ...common,
    '@deepseek-ai/dsh-agent-default-model': version,
    '@deepseek-ai/dsh-client-ui-conversation': version,
    '@deepseek-ai/dsh-llm': version,
    '@deepseek-ai/dsh-session': version,
    '@deepseek-ai/dsh-settings': version,
    '@deepseek-ai/dsh-system-prompt': version,
    '@deepseek-ai/dsh-tools': version,
  }
}

describe('DSH runtime compatibility', () => {
  it('accepts the complete 0.1.2 host family', () => {
    expect(classifyDshRuntime(versions('0.1.2-rc.1')).cliVersion).toBe('0.1.2-rc.1')
  })

  it('accepts the real 0.1.5-rc.1 dependency tree at rc.2', () => {
    expect(classifyDshRuntime(versions('0.1.5-rc.2')).cliVersion).toBe('0.1.5-rc.1')
  })

  it('rejects a mixed profile-local DSH runtime with a clear diagnostic', () => {
    const mixed = { ...versions('0.1.5-rc.2'), '@deepseek-ai/dsh-session': '0.1.2-rc.1' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(mixed)).toThrow(/dsh-session@0\.1\.2-rc\.1/)
  })

  it('uses each host version\'s native surface replacement shape', () => {
    expect(buildDshReplaceSurfaceOp('0.1.2-rc.1', 2, 5)).toEqual({ op: 'replace', start: 2, end: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.5-rc.2', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
  })
})
