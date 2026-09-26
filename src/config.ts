import z from '@deepseek-ai/schemastery'

export type NamespaceMode = 'project' | 'session' | 'global'
export type StructuredReasoningEffortMode = 'auto' | 'force-off'

export interface Config {
  database?: string
  sessionRoot?: string
  namespaceMode?: NamespaceMode
  namespacePrefix?: string
  globalNamespace?: string
  blockTurnSize?: number
  blockDecayLambda?: number
  ingestSubagents?: boolean
  agentMemoryEnabled?: boolean
  agentMemoryRetrievalWeight?: number
  provider?: string
  model?: string
  maxOutputTokens?: number
  structuredTaskTimeoutMs?: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
  showStrataGateStatus?: boolean
  showShortTermStatus?: boolean
  showRetrievalStatus?: boolean
}

export interface ResolvedConfig {
  database: string
  sessionRoot?: string
  namespaceMode: NamespaceMode
  namespacePrefix: string
  globalNamespace: string
  blockTurnSize: number
  blockDecayLambda: number
  ingestSubagents: boolean
  agentMemoryEnabled?: boolean
  agentMemoryRetrievalWeight?: number
  provider?: string
  model?: string
  maxOutputTokens: number
  structuredTaskTimeoutMs?: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
  showStrataGateStatus?: boolean
  showShortTermStatus?: boolean
  showRetrievalStatus?: boolean
}

export interface StructuredReasoningEffortSettings {
  structuredReasoningEffort: StructuredReasoningEffortMode
  showStrataGateStatus: boolean
  showShortTermStatus: boolean
  showRetrievalStatus: boolean
}

export const StructuredReasoningEffortSettings: z<StructuredReasoningEffortSettings> = z.object({
  structuredReasoningEffort: z.union(['auto', 'force-off'] as const).default('auto')
    .description('记忆处理结构化调用的推理档位策略')
    .comment('auto：仅在模型明确支持 off 时使用；force-off：优先使用 off，不支持或能力检查失败时安全降级，并对同一模型只告警一次。'),
  showStrataGateStatus: z.boolean().default(true)
    .description('显示 StrataGate 状态提示')
    .comment('关闭后隐藏聊天界面中的 StrataGate 状态信息；记忆、检索和后台处理不受影响。'),
  showShortTermStatus: z.boolean().default(true)
    .description('显示短期记忆块状态')
    .comment('控制短期记忆块进度、Block 封存与整理状态的聊天内提示；后台处理不受影响。'),
  showRetrievalStatus: z.boolean().default(true)
    .description('显示记忆检索状态')
    .comment('控制检索次数、返回数量和记忆采用信息的聊天内提示；检索与采用不受影响。'),
})

// Schemastery 3.18.2 (DSH <= 0.1.6) has no volatile fields. Earlier hosts
// publish these controls through settings.installSection instead.
export function volatileIfSupported<T>(schema: T): T {
  return (schema as { volatile?: () => T }).volatile?.() ?? schema
}

export const Config = z.object({
  database: z.string().required(),
  sessionRoot: z.string(),
  namespaceMode: z.union(['project', 'session', 'global'] as const).default('project'),
  namespacePrefix: z.string().default('dsh'),
  globalNamespace: z.string().default('global'),
  blockTurnSize: z.natural().min(1).default(6),
  blockDecayLambda: z.number().step(0.05).min(0).default(0.3)
    .description('Block 衰减系数 λ')
    .comment('默认 0.3；数字越小，记忆遗忘越慢，消耗 token 越多，不建议大于 0.4。'),
  ingestSubagents: z.boolean().default(false),
  agentMemoryEnabled: z.boolean().default(true)
    .description('启用 agent 主动记忆（memory_remember）')
    .comment('开启后 agent 可以把值得记忆的事实写入长期记忆 Event 管线：进入数据库、参与知识图谱、跨会话共享；写入前会自动检测并消解重复与冲突。'),
  agentMemoryRetrievalWeight: z.number().step(0.05).min(0).max(5).default(1)
    .description('主动记忆在检索中的占比权重')
    .comment('agent 记录与对话派生记忆分别独立排序后按权重融合：1 为平权，0 为不浮现 agent 记录，大于 1 则提升 agent 记录的排序权重。'),
  provider: z.string(),
  model: z.string(),
  maxOutputTokens: z.natural().min(256).default(2_048),
  structuredTaskTimeoutMs: z.natural().min(1_000).default(120_000),
  structuredReasoningEffort: volatileIfSupported(z.union(['auto', 'force-off'] as const).default('auto')),
  showStrataGateStatus: volatileIfSupported(z.boolean().default(true)),
  showShortTermStatus: volatileIfSupported(z.boolean().default(true)),
  showRetrievalStatus: volatileIfSupported(z.boolean().default(true)),
})

export function liveConfigValue<T>(value: T): T {
  return value && typeof value === 'object' && 'get' in value && typeof value.get === 'function'
    ? (value as { get(): T }).get()
    : value
}

export function isLiveConfigValue(value: unknown): value is { get(): unknown } {
  return value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function'
}

export function resolveConfig(config: Config): ResolvedConfig {
  const database = config.database?.trim() ?? ''
  const sessionRoot = config.sessionRoot?.trim()
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
    ...(sessionRoot ? { sessionRoot } : {}),
    namespaceMode: config.namespaceMode ?? 'project',
    namespacePrefix,
    globalNamespace,
    blockTurnSize: Math.max(1, Math.floor(config.blockTurnSize ?? 6)),
    blockDecayLambda: Math.max(0, config.blockDecayLambda ?? 0.3),
    ingestSubagents: config.ingestSubagents ?? false,
    agentMemoryEnabled: config.agentMemoryEnabled ?? true,
    agentMemoryRetrievalWeight: Math.min(5, Math.max(0, config.agentMemoryRetrievalWeight ?? 1)),
    ...(provider && model ? { provider, model } : {}),
    maxOutputTokens: Math.max(256, Math.floor(config.maxOutputTokens ?? 2_048)),
    structuredTaskTimeoutMs: Math.max(1_000, Math.floor(config.structuredTaskTimeoutMs ?? 120_000)),
    structuredReasoningEffort: liveConfigValue(config.structuredReasoningEffort) ?? 'auto',
    showStrataGateStatus: liveConfigValue(config.showStrataGateStatus) ?? true,
    showShortTermStatus: liveConfigValue(config.showShortTermStatus) ?? true,
    showRetrievalStatus: liveConfigValue(config.showRetrievalStatus) ?? true,
  }
}
