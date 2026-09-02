import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'

describe('DeepSeek Harness plugin config', () => {
  it('resolves safe defaults', () => {
    expect(resolveConfig({ database: ' ./memory.db ' })).toEqual({
      database: './memory.db',
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      structuredReasoningEffort: 'auto',
      maxOutputTokens: 10000,
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

  it('exposes the structured reasoning effort policy with a safe default', () => {
    const field = Config.dict?.structuredReasoningEffort
    expect(field?.meta).toMatchObject({
      default: 'auto',
      description: '记忆处理结构化调用的推理档位策略',
    })
    expect(resolveConfig({ database: 'memory.db' }).structuredReasoningEffort).toBe('auto')
    expect(resolveConfig({ database: 'memory.db', structuredReasoningEffort: 'force-off' }).structuredReasoningEffort).toBe('force-off')
  })
})
