# Issue #119 修复与验证

基线：`e954eaf2f2cbbef4bb6226a2ebb35191424868c2`（main，stratagate-dsh 0.3.6）。

## 根因与修改

- 日志中的 656、778 字符概要均正常结束于 `tool-calls`，被 600 字符业务上限拒绝，不能归因于 token 截断。现在使用 `TOPIC_OVERVIEW_MAX_CHARACTERS = 1000`，按 Unicode code point 计数，保留原文，不截断。
- DSH `StringValueSchemaSpec` 只支持类型、枚举、常量和注解，不支持 `maxLength`。工具字段说明与提示词引用同一常量，解析器和存储提交门调用同一校验函数。
- 旧 `TopicOverviewRepairGuard` 把未保存的违规草稿计数和来源持久化成补写义务，还从历史字段错误推导“至少一段”的要求。删除这套草稿守卫、错误携带和跨批分配逻辑，保留语义去重。旧 `overviewRepairRequirements` 字段仅供快照兼容与识别恢复对象，不发送给模型、不约束提交，重排、失败或成功时清理。
- 有效旧概要仍由原有存储逻辑继承；章节成员与小节归属、来源权限、批次覆盖、源版本、租约、陈旧响应和原子提交检查继续生效。原有合法重分类、来源失效和遗忘语义不变，旧小节消失时仍按现有规则移除孤立概要。
- 提示词先要求完整事件归类；新增概要通常 0～2 段，无必要时允许空数组，建议 300～600 字符，不为凑长度省略事实，不复述已有内容。
- 沿用 `recoveryVersion`，升级为 2。仅恢复仍有效、有未完成工作且命中概要字段、旧草稿要求、Provider 失败或原始 `invalid-output` 签名的终态任务。无关内容校验、超时和 worker 失败不获得新周期。已完成来源、失效来源、已有排队工作、重启和并发写入沿用原有排除与持久化机制；单周期仍最多三次任务尝试，没有新增恢复状态机。

## Provider 预算与剩余证据

DSH `LlmResolvedModelInfo` 公开 `context.contextWindow` 和 `defaultMaxTokens`；后者仅是未显式指定输出预算时使用的普通默认值，不证明模型能力，也不限制 Topic 的独立请求。Topic 保留 32,768 上限，仅按实际 provider/model 路由已知的上下文剩余空间收缩。当前元数据没有可用的已验证模型输出硬上限，不据默认值猜测 Provider 限制。提示中的预算与每次实际请求保持一致，包括内容重试和 reasoning-off 回退。审查后的实现删除了普通默认值限流和对应缓存。

无法容纳输入的模型配置报告 `provider-failed`，不归类成内容校验错误。输出实际截断继续用 `max-tokens` 和现有有界拆批；Provider 异常继续走现有任务退避，无新增专属补丁或重试次数。普通默认值为 512、1024 的路由测试使用 12 张 Event 和两段 1000 字符概要，完整响应的估算 token 超过这些默认值，断言实际请求仍使用独立预算并只调用一次；这是模拟流的请求策略验证，不是低实际预算下的真实生成能力测试。人工重试路径同时保留携带敏感响应的普通 `worker-failed` 脱敏测试。

Issue 中那次 `finishReason=error` 的根因尚未确认。32,768 可能超过部分模型的输出能力，但也可能是限流、路由或其他请求错误。确认仍需要实际 Provider/model 标识、路由配置的 defaultMaxTokens 与 contextWindow、Provider 错误码/HTTP 状态/请求编号，以及 token usage（含 reasoning）和对应失败请求日志。不得凭当前安全摘要断言是哪一项。

## 固定模拟响应对比

在固定 main 与首轮修复提交 `6edcb34445e58e9df1ede0189e118672f90fcb42` 上运行同一临时重放测试，使用 `tests/llm.test.ts` 的 `modelBridge`、`context`、`proposal` 辅助函数；只把新概要 text 替换成 `𠮷.repeat(length)`。第一次与第二次流均正常结束于 `tool-calls`；656、778、1000 的第二次响应重复原响应；1001 的第二次响应返回空概要且保留全部章节/小节归类。其余输入与输出一致。保留这次原始测量；审查修复不改变这些未配置路由默认值的概要校验场景，新的定向测试继续覆盖其行为。

| 首次字符数 | 修复前结果 / 调用数 | 修复后结果 / 调用数 |
| --- | --- | --- |
| 656 | 长度校验失败 / 2 | 首次通过 / 1 |
| 778 | 长度校验失败 / 2 | 首次通过 / 1 |
| 1000 | 长度校验失败 / 2 | 首次通过 / 1 |
| 1001 → 空概要 | 草稿守卫拒绝 / 2 | 合法重试通过 / 2 |

这组样例首次通过率 0/4 → 3/4，总调用数 8 → 5，最终完成 0/4 → 4/4。1001 字符始终拒绝，成功来自第二次合法结果。原始输出保存在 [修复前](issue119-before.json) 与 [修复后](issue119-after.json)。这是模拟流经过真实实现的测量，不是线上成功率、真实模型遵从度或提示词效果的测量；未调用真实 Provider，未读取用户数据库。

## 回归范围

定向测试覆盖 656、778、1000 / 1001 与补充平面 Unicode 字符，字段级诊断、Schema 与提示词、草稿舍弃、完整 Event 分类、旧概要和来源继承、伪造来源和遗漏 Event 拒绝、SQLite 重启、旧恢复要求、部分完成与重叠任务、重复提交、并发初始化、失败后有界拆批，以及 Provider 预算配置与分类。

首轮修复提交在 Node 24.19.0 下：`npm run check` 全部通过；`npm test` 的 core 286、DSH 580、WorkBuddy 10 项通过，共 876 项通过、1 项既有跳过；`npm run build` 的 core、DSH 和 WorkBuddy 全部通过。隔离安装最初跳过安装脚本，导致旧数据库迁移测试缺少 better-sqlite3 绑定；用相同 Node 24 执行 `npm rebuild better-sqlite3` 后，完整测试通过。未修改依赖或锁文件。

审查修复后的本地验证：`tests/llm.test.ts` 与 `tests/memory-topics.test.ts` 共 194 项通过，`packages/core/tests/topic-recovery.test.ts` 25 项通过，共 219 项定向测试通过；`npm run check` 和 `npm run build` 全部通过。已自查实际预算反馈、内容重试与 reasoning-off 回退、上下文预检分类、持久化来源/归属/旧概要保护和有界恢复路径。新提交仍需独立复审及其对应的 CI 结果；未执行用户真实 Windows + DSH 数据库的升级验收。
