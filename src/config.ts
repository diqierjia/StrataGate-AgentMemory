import z from '@deepseek-ai/schemastery'

export type NamespaceMode = 'project' | 'session' | 'global'
export type StructuredReasoningEffortMode = 'auto' | 'force-off'
export interface MemoryModelSelection {
  mode: 'auto' | 'custom'
  provider?: string
  model?: string
}

const MemoryModelSelectionSchema = z.union([
  z.object({ mode: z.const('auto').required() }),
  z.object({ mode: z.const('custom').required(), provider: z.string().min(1).required(), model: z.string().min(1).required() }),
])

export function resolveMemoryModel(value: MemoryModelSelection | undefined): MemoryModelSelection | undefined {
  if (value === undefined) return undefined
  if (value.mode === 'auto') return { mode: 'auto' }
  if (value.mode !== 'custom' || !value.provider?.trim() || !value.model?.trim()) {
    throw new TypeError('记忆处理模型需要同时选择服务商和模型')
  }
  return { mode: 'custom', provider: value.provider.trim(), model: value.model.trim() }
}

export interface Config {
  dailyNotesEnabled?: boolean
  dailyNotesTimeZone?: string
  dailyNotesInjectionDays?: number
  dailyNotesContextMaxChars?: number
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
  embeddingUrl?: string
  embeddingKey?: string
  embeddingModel?: string
  vectorWeight?: number
  embeddingMinScore?: number
  rerankUrl?: string
  rerankKey?: string
  rerankModel?: string
  provider?: string
  model?: string
  memoryModel?: MemoryModelSelection
  maxOutputTokens?: number
  structuredTaskTimeoutMs?: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
  showStrataGateStatus?: boolean
  showShortTermStatus?: boolean
  showRetrievalStatus?: boolean
  showSidebarEntry?: boolean
}

export interface ResolvedConfig {
  dailyNotesEnabled?: boolean
  dailyNotesTimeZone?: string
  dailyNotesInjectionDays?: number
  dailyNotesContextMaxChars?: number
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
  embeddingUrl?: string
  embeddingKey?: string
  embeddingModel?: string
  vectorWeight?: number
  embeddingMinScore?: number
  rerankUrl?: string
  rerankKey?: string
  rerankModel?: string
  provider?: string
  model?: string
  memoryModel?: MemoryModelSelection
  maxOutputTokens: number
  structuredTaskTimeoutMs?: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
  showStrataGateStatus?: boolean
  showShortTermStatus?: boolean
  showRetrievalStatus?: boolean
  showSidebarEntry?: boolean
}

export interface StructuredReasoningEffortSettings {
  memoryModel?: MemoryModelSelection
  structuredReasoningEffort: StructuredReasoningEffortMode
  showStrataGateStatus: boolean
  showShortTermStatus: boolean
  showRetrievalStatus: boolean
  showSidebarEntry: boolean
}

export const StructuredReasoningEffortSettings: z<StructuredReasoningEffortSettings> = z.object({
  memoryModel: MemoryModelSelectionSchema.description('记忆处理模型'),
  structuredReasoningEffort: z.union(['auto', 'force-off'] as const).default('auto')
    .description('记忆处理结构化调用的推理档位策略')
    .comment('auto：仅在模型明确支持 off 时使用；force-off：优先使用 off，不支持或能力检查失败时安全降级，并对同一模型只告警一次。'),
  showStrataGateStatus: z.boolean().default(true)
    .description('显示 StrataGate 状态提示')
    .comment('关闭后隐藏聊天界面中的 StrataGate 状态信息；记忆、检索和后台处理不受影响。'),
  showShortTermStatus: z.boolean().default(true)
    .description('显示会话记忆状态')
    .comment('控制会话记忆进度、Block 封存与整理状态的聊天内提示；后台处理不受影响。'),
  showSidebarEntry: z.boolean().default(false)
    .description('在左侧栏显示 StrataGate')
    .comment('仅控制左侧栏入口；关闭后仍可从设置打开，记忆、检索和后台处理不受影响。'),
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
  dailyNotesEnabled: volatileIfSupported(z.boolean().default(true)),
  dailyNotesTimeZone: volatileIfSupported(z.string()),
  dailyNotesInjectionDays: volatileIfSupported(z.natural().min(1).max(30).default(3)),
  dailyNotesContextMaxChars: z.natural().min(1024).default(12_000),
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
  embeddingUrl: z.string().default('')
    .description('Embedding API 地址')
    .comment('OpenAI 兼容接口，例如 https://api.siliconflow.cn/v1。留空 = 不启用语义检索，检索行为与未配置时完全一致。'),
  embeddingKey: z.string().default('')
    .description('Embedding API Key')
    .comment('与 embeddingUrl、embeddingModel 配套；三者都填了才启用。'),
  embeddingModel: z.string().default('')
    .description('Embedding 模型名')
    .comment('例如 BAAI/bge-m3。换模型后旧向量不会被删除，只是不再参与检索。'),
  vectorWeight: z.number().step(0.1).min(0).max(5).default(1)
    .description('向量召回在检索中的占比权重')
    .comment('语义召回与关键词召回按权重融合：1 为平权，0 为不启用向量车道。'),
  embeddingMinScore: z.number().step(0.05).min(0).max(1).default(0.3)
    .description('向量召回的最低相似度')
    .comment('余弦相似度低于该值的事件不进入语义召回结果；0 表示不设门槛。默认 0.3 高于随机文本对的相似度，避免「没找到」变成总要凑几条。'),
  rerankUrl: z.string().default('')
    .description('Rerank API 地址')
    .comment('与 embedding 独立配置，例如 https://api.siliconflow.cn/v1。留空 = 不精排，召回顺序与未配置时一致。'),
  rerankKey: z.string().default('')
    .description('Rerank API Key')
    .comment('与 rerankUrl、rerankModel 配套；三者都填了才启用。'),
  rerankModel: z.string().default('')
    .description('Rerank 模型名')
    .comment('例如 BAAI/bge-reranker-v2-m3。精排只作用于被动召回的候选，超时或报错时静默回退原顺序。'),
  provider: z.string(),
  model: z.string(),
  memoryModel: volatileIfSupported(MemoryModelSelectionSchema.description('记忆处理模型')),
  maxOutputTokens: z.natural().min(256).default(2_048),
  structuredTaskTimeoutMs: z.natural().min(1_000).default(120_000),
  structuredReasoningEffort: volatileIfSupported(z.union(['auto', 'force-off'] as const).default('auto')),
  showStrataGateStatus: volatileIfSupported(z.boolean().default(true)),
  showShortTermStatus: volatileIfSupported(z.boolean().default(true)),
  showRetrievalStatus: volatileIfSupported(z.boolean().default(true)),
  showSidebarEntry: volatileIfSupported(z.boolean().default(false)),
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
  const dailyNotesEnabled = liveConfigValue(config.dailyNotesEnabled)
  const dailyNotesTimeZone = liveConfigValue(config.dailyNotesTimeZone)
  const dailyNotesInjectionDays = liveConfigValue(config.dailyNotesInjectionDays)
  const database = config.database?.trim() ?? ''
  const sessionRoot = config.sessionRoot?.trim()
  const namespacePrefix = config.namespacePrefix?.trim() || 'dsh'
  const globalNamespace = config.globalNamespace?.trim() || 'global'
  const provider = config.provider?.trim()
  const model = config.model?.trim()
  const memoryModel = resolveMemoryModel(liveConfigValue(config.memoryModel))
  if (!database) throw new TypeError('StrataGate database path must not be empty')
  if (Boolean(provider) !== Boolean(model)) {
    throw new TypeError('StrataGate provider and model must be configured together')
  }
  if (dailyNotesTimeZone !== undefined) new Intl.DateTimeFormat('en-US', { timeZone: dailyNotesTimeZone }).format()
  if (config.dailyNotesContextMaxChars !== undefined && (!Number.isSafeInteger(config.dailyNotesContextMaxChars) || config.dailyNotesContextMaxChars < 1024)) throw new TypeError('dailyNotesContextMaxChars must be an integer >= 1024')
  if (dailyNotesInjectionDays !== undefined && (!Number.isSafeInteger(dailyNotesInjectionDays) || dailyNotesInjectionDays < 1 || dailyNotesInjectionDays > 30)) throw new TypeError('dailyNotesInjectionDays must be an integer between 1 and 30')
  return {
    dailyNotesInjectionDays: dailyNotesInjectionDays ?? 3,
    dailyNotesEnabled: dailyNotesEnabled ?? true,
    ...(dailyNotesTimeZone !== undefined ? { dailyNotesTimeZone } : {}),
    dailyNotesContextMaxChars: config.dailyNotesContextMaxChars ?? 12_000,
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
    ...(config.embeddingUrl !== undefined ? { embeddingUrl: config.embeddingUrl.trim() } : {}),
    ...(config.embeddingKey !== undefined ? { embeddingKey: config.embeddingKey.trim() } : {}),
    ...(config.embeddingModel !== undefined ? { embeddingModel: config.embeddingModel.trim() } : {}),
    ...(config.vectorWeight !== undefined
      ? { vectorWeight: Math.min(5, Math.max(0, config.vectorWeight)) }
      : {}),
    ...(config.embeddingMinScore !== undefined
      ? { embeddingMinScore: Math.min(1, Math.max(0, config.embeddingMinScore)) }
      : {}),
    ...(config.rerankUrl !== undefined ? { rerankUrl: config.rerankUrl.trim() } : {}),
    ...(config.rerankKey !== undefined ? { rerankKey: config.rerankKey.trim() } : {}),
    ...(config.rerankModel !== undefined ? { rerankModel: config.rerankModel.trim() } : {}),
    ...(provider && model ? { provider, model } : {}),
    ...(memoryModel ? { memoryModel } : {}),
    maxOutputTokens: Math.max(256, Math.floor(config.maxOutputTokens ?? 2_048)),
    structuredTaskTimeoutMs: Math.max(1_000, Math.floor(config.structuredTaskTimeoutMs ?? 120_000)),
    structuredReasoningEffort: liveConfigValue(config.structuredReasoningEffort) ?? 'auto',
    showStrataGateStatus: liveConfigValue(config.showStrataGateStatus) ?? true,
    showShortTermStatus: liveConfigValue(config.showShortTermStatus) ?? true,
    showRetrievalStatus: liveConfigValue(config.showRetrievalStatus) ?? true,
    showSidebarEntry: liveConfigValue(config.showSidebarEntry) ?? false,
  }
}
