# Event Extractor v2

新版规则只用于升级后正常提取的新 Event。不会重放旧 L5、改写旧标题、拆分或合并旧 Event，也不会回填分类提示或版本号。已有待处理任务仍按正常重试规则处理。

## 提取判断

判断独立含义及遗忘成本，而不是以重要性、criticality 或消息角色作为统一门槛。用户事实、评价、审美反馈、明确要求、纠正、改变决定和可复用指导采用较低提取门槛；普通 Agent / Tool 执行步骤采用较高门槛。已确认根因、平台限制、失败条件、可复用经验和重要结果仍可独立保留。Summarizer 的高召回预筛同步提示这些候选。

保守使用现有 scope：单次答复要求保留 session 范围；项目要求使用 project；明确长期指导才可使用 user。重复纠正可以成为经验的证据，但不能把一次局部反馈扩大成永久人格或审美。两个能独立变化、被检索、冲突或替代的事实仍分开；原子化不等于记录每次工具调用。标题保留明确对象、稳定锚点和一个主要变化，详细原因留在 summary。
Extractor 结构化输出必须明确返回合法 scope。工具调用及文本 fallback 都先进行同一 schema 验证；遗漏或非法值触发现有有界重试，重试仍失败时不写入 Event，不再默认扩大为 project。核心旧 Event、手工输入及自定义 Extractor 的兼容类型不变。

## 重复与关系

同一 Block 内的同义表达由模型识别为一条事实，保留直接支持它的目标消息 ID。适配层额外合并同一次输出中 title、summary、scope、criticality 和 temporal 完全相同的卡片，比较截断前的完整模型文本，合并目标来源及检索标签；不同事实、范围或关系不合并。
精确重复卡的 catalogHints 保留第一张卡的归一化结果，包括第一张缺省时继续缺省；不合并或追加后续卡的类别。

纯重复且没有新增长期信息可不提取；明确强化或延续用 sameEventId，替代/纠正用 supersedesEventIds，无法确认替代的矛盾用 conflictsWithEventIds。历史卡保留。相同项目、关键词近似不能单独建立关系。现有 timeline 仍最多提供 8 条相关及 4 条最近 Event，增加每条最多 400 字符的摘要、范围和历史状态以辅助识别；字段对自定义 Extractor 保持可选。timeline / neighbor 只供理解和关系匹配，不能为新事实提供来源。

## 可选字段与兼容

| 字段 | 语义 | 边界 |
| --- | --- | --- |
| `catalogHints?: string[]` | 长期类别的自由短语，仅供导航 | 最多 2 个，每个最多 64 个 Unicode 字符；可以缺省或为空；不设 enum 或 other/其他兜底，不指定目录 ID/路径，不改写标题来充当类别 |
| `extractorVersion?: number` | 对话提取规则版本 | DSH Extractor 在代码中标记为 `2`，不让模型决定；旧卡、手工卡及其他 Extractor 缺省合法 |

运行时限制提示数量，移除空白、重复、非法类型、明显兜底和目录 ID/路径；类别是否有来源、是否只是标题改写等语义约束由 prompt 负责。Topic Projector 可见 catalogHints 用于路由，但不能据此生成事实或决定章/节。Element 和 Graph 都用字段白名单构造 Event 模型输入，物理排除提示和版本号；Element 保留事实正文、引用、目标来源、时间、范围、criticality 和历史关系。检索的事实字段、provenance、时间、criticality 和 admission 机制不变。

SQLite 用新增的可选 `event_metadata` 附表保存这两个字段，支持 passive / agent 两个 Event 池，随原有事务保存和清理。只为已有字段的卡写元数据行；不 ALTER 旧 Event 表或重建历史数据，存储 schema 仍为 12。旧库没有附表也可以只读打开；普通写入器打开时创建空表。旧 Event 的 API 字段形状保持原样，新字段存在时才输出。

## 验证边界

确定性测试验证 prompt/schema 合约、模型输出归一化、同 Block 精确去重、目标来源边界、relation 写入、SQLite 往返、旧库只读/升级、无历史重提取/回填，以及旧卡的检索、Topic、Graph、API 和 UI 路径。测试里的模型响应是 mock，并非真实模型语义准确率测量；同义识别、提取敏感度及泛化质量仍取决于实际模型。未新增模型调用、依赖、全局 consolidation 或目录算法。
