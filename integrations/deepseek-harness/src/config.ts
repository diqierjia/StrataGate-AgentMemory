import z from '@deepseek-ai/schemastery'

export type NamespaceMode = 'project' | 'session' | 'global'

/** How structured memory-processing LLM calls select their reasoning effort.
 * - `auto`: probe the exact model's advertised reasoning efforts; use `off`
 *   when supported, otherwise fall back to the model's default effort.
 * - `force-off`: always request `off`; if the model does not support it, the
 *   call degrades to the model's default effort with a single warning instead
 *   of failing, so one unsupported provider can never trigger a retry storm.
 */
export type StructuredReasoningEffortMode = 'auto' | 'force-off'

export interface Config {
  database?: string
  namespaceMode?: NamespaceMode
  namespacePrefix?: string
  globalNamespace?: string
  blockTurnSize?: number
  blockDecayLambda?: number
  ingestSubagents?: boolean
  provider?: string
  model?: string
  maxOutputTokens?: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
}

export interface ResolvedConfig {
  database: string
  namespaceMode: NamespaceMode
  namespacePrefix: string
  globalNamespace: string
  blockTurnSize: number
  blockDecayLambda: number
  ingestSubagents: boolean
  provider?: string
  model?: string
  maxOutputTokens: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
}

export const Config: z<Config> = z.object({
  database: z.string().required(),
  namespaceMode: z.union(['project', 'session', 'global'] as const).default('project'),
  namespacePrefix: z.string().default('dsh'),
  globalNamespace: z.string().default('global'),
  blockTurnSize: z.natural().min(1).default(6),
  blockDecayLambda: z.number().step(0.05).min(0).default(0.3)
    .description('Block 衰减系数 λ')
    .comment('默认 0.3；数字越小，记忆遗忘越慢，消耗 token 越多，不建议大于 0.4。'),
  ingestSubagents: z.boolean().default(false),
  structuredReasoningEffort: z.union(['auto', 'force-off'] as const).default('auto')
    .description('记忆处理结构化调用的推理档位策略')
    .comment('auto：模型支持 off 时用 off，不支持则退化为模型默认档位；force-off：强制 off，模型不支持时降级为模型默认档位并告警一次。'),
  provider: z.string(),
  model: z.string(),
  maxOutputTokens: z.natural().min(256).default(10_000),
})

export function resolveConfig(config: Config): ResolvedConfig {
  const database = config.database?.trim() ?? ''
  const namespacePrefix = config.namespacePrefix?.trim() || 'dsh'
  const globalNamespace = config.globalNamespace?.trim() || 'global'
  const provider = config.provider?.trim()
  const model = config.model?.trim()
  if (!database) throw new TypeError('StrataGate database path must not be empty')
  if (Boolean(provider) !== Boolean(model)) {
    throw new TypeError('StrataGate provider and model must be configured together')
  }
  return {
    database,
    namespaceMode: config.namespaceMode ?? 'project',
    namespacePrefix,
    globalNamespace,
    blockTurnSize: Math.max(1, Math.floor(config.blockTurnSize ?? 6)),
    blockDecayLambda: Math.max(0, config.blockDecayLambda ?? 0.3),
    ingestSubagents: config.ingestSubagents ?? false,
    ...(provider && model ? { provider, model } : {}),
    maxOutputTokens: Math.max(256, Math.floor(config.maxOutputTokens ?? 10_000)),
    structuredReasoningEffort: config.structuredReasoningEffort ?? 'auto',
  }
}
