import { describe, expect, it } from 'vitest'
import { Config, resolveConfig, volatileIfSupported } from '../src/config.js'

describe('DeepSeek Harness plugin config', () => {
  it('keeps old Schemastery fields usable without the volatile method', () => {
    const legacy = { meta: { default: true } }
    expect(volatileIfSupported(legacy)).toBe(legacy)
    const current = { volatile: () => ({ meta: { volatile: true } }) }
    expect(volatileIfSupported(current)).toEqual({ meta: { volatile: true } })
  })

  it('resolves safe defaults', () => {
    expect(resolveConfig({ database: ' ./memory.db ' })).toEqual({
      database: './memory.db',
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      agentMemoryEnabled: true,
      agentMemoryRetrievalWeight: 1,
      maxOutputTokens: 2048,
      structuredTaskTimeoutMs: 120000,
      structuredReasoningEffort: 'auto',
      showStrataGateStatus: true,
      showShortTermStatus: true,
      showRetrievalStatus: true,
    })
  })

  it('requires an explicit model pair', () => {
    expect(() => resolveConfig({ database: 'memory.db', provider: 'deepseek' }))
      .toThrow('provider and model must be configured together')
  })

  it('exposes the Block decay coefficient and guidance in the plugin form', () => {
    const field = Config.dict?.blockDecayLambda
    expect(field?.meta).toMatchObject({
      default: 0.3,
      min: 0,
      step: 0.05,
      description: 'Block 衰减系数 λ',
      comment: '默认 0.3；数字越小，记忆遗忘越慢，消耗 token 越多，不建议大于 0.4。',
    })
    expect(resolveConfig({ database: 'memory.db', blockDecayLambda: 0.15 }).blockDecayLambda).toBe(0.15)
  })

  it('exposes the agent memory switch and retrieval weight with safe defaults', () => {
    expect(Config.dict?.agentMemoryEnabled?.meta).toMatchObject({ default: true })
    expect(Config.dict?.agentMemoryRetrievalWeight?.meta).toMatchObject({ default: 1, min: 0, max: 5 })
    expect(resolveConfig({ database: 'memory.db' })).toMatchObject({
      agentMemoryEnabled: true,
      agentMemoryRetrievalWeight: 1,
    })
    expect(resolveConfig({ database: 'memory.db', agentMemoryEnabled: false }).agentMemoryEnabled).toBe(false)
    expect(resolveConfig({
      database: 'memory.db',
      agentMemoryRetrievalWeight: -1,
    }).agentMemoryRetrievalWeight).toBe(0)
    expect(resolveConfig({
      database: 'memory.db',
      agentMemoryRetrievalWeight: 99,
    }).agentMemoryRetrievalWeight).toBe(5)
  })

  it('resolves the structured reasoning effort policy with a safe default', () => {
    expect(resolveConfig({ database: 'memory.db' }).structuredReasoningEffort).toBe('auto')
    expect(resolveConfig({
      database: 'memory.db',
      structuredReasoningEffort: 'force-off',
    }).structuredReasoningEffort).toBe('force-off')
  })

  it('exposes persistent defaults for all chat display preferences', () => {
    expect(Config.dict?.showStrataGateStatus?.meta).toMatchObject({ default: true, volatile: true })
    expect(Config.dict?.showShortTermStatus?.meta).toMatchObject({ default: true, volatile: true })
    expect(Config.dict?.showRetrievalStatus?.meta).toMatchObject({ default: true, volatile: true })
    expect(Config.dict?.structuredReasoningEffort?.meta).toMatchObject({ volatile: true })
    expect(resolveConfig({ database: 'memory.db' })).toMatchObject({
      showStrataGateStatus: true,
      showShortTermStatus: true,
      showRetrievalStatus: true,
    })
    expect(resolveConfig({
      database: 'memory.db',
      showStrataGateStatus: false,
      showShortTermStatus: false,
      showRetrievalStatus: false,
    })).toMatchObject({
      showStrataGateStatus: false,
      showShortTermStatus: false,
      showRetrievalStatus: false,
    })
  })

  it('reads the live DSH 0.1.7 preference snapshot without changing older plain configs', () => {
    const live = { get: () => false }
    expect(resolveConfig({ database: 'memory.db', showStrataGateStatus: live as unknown as boolean }).showStrataGateStatus).toBe(false)
    expect(resolveConfig({ database: 'memory.db', showStrataGateStatus: true }).showStrataGateStatus).toBe(true)
  })
})
