# Changelog

## 0.3.14 - 2026-10-16

- Persistent Profile 仅有称呼、语言、位置等受保护短字段时，不再调用模型整理；这些字段的单字段容量也不再触发整理。
- 成功整理后，可整理内容未变化便不再按 24 小时周期重复调用；仅修改受保护字段不会重新触发。可整理内容变化后仍沿用原有时间与容量条件，保留失败退避和并发写入保护。

## 0.3.13 - 2026-10-15

- 移除 Dreaming 的“消耗边界”、累计 token 上限设置和目录页估算消耗展示；旧任务继续时自动清除历史上限并保留进度与会话，内部计量和异常暂停保护保留。

## 0.3.12 - 2026-10-15

- 新增目录 Dreaming Agent：从目录页启动，通过专属会话查看运行详情，支持进度、暂停、继续与终止；保留原始 Event 事实。
- 提供独立的只读检索和来源分页工具，目录修改经来源、版本和归属校验后原子提交；持久化断点支持恢复。
- 注入用户画像与当前批次，压缩工作上下文；一次 Dreaming 使用独立会话，批次连续推进到整轮完成。
- 修复空回复导致过早停止、正常推理和目录分页被误判为空转，以及错误重试和无效输出可能持续消耗的问题；保留用户设置的消耗边界。
- 用临时窗口完整展示默认注入给 AI 的目录内容，简化目录页说明。

## 0.3.12-candidate.5 - 2026-10-15（候选编号 0.3.12.5，未正式发布）

- 空响应或普通说明不再立即结束 Dreaming：在同一 Agent Loop 内自动继续，连续三次没有工具行动才暂停；复用持久化计数，工具检查点和完成批次后重置。
- 8192 Token 的无工具叙述边界只统计普通文本，避免正常 reasoning 尚未调用工具就被误停；单次 32768 Token 总边界与真实错误暂停保留。
- 切批提示明确区分已完成的上一批与待处理的当前批，整轮完成后才结束。
- 修复目录列表正常翻页也被当作无进展的问题；新目录项计入进展并持久保存，换关键词重复查看已读项不重置空转计数。

## 0.3.12-candidate.4 - 2026-10-15（候选编号 0.3.12.4，未正式发布）

- 根据真实运行 trace 增加无工具调用回复的 8192 Token 边界；模型长篇重复叙述但未发出 Dreaming 工具调用时中断当前请求，保存断点并暂停，不影响已发出原生工具调用的步骤。

## 0.3.12-candidate.3 - 2026-10-15（候选编号 0.3.12.3，未正式发布）

- Dreaming 专属 system prompt 注入 Persistent Profile；仅在相关时参考画像偏好和持久要求，画像不作为目录证据，也不改变工具权限、范围或完成条件。
- 目录进度显示批次计数（例如 `1/14 批次 · 7%`），避免被误解为章节进度；章节可能拆成多个批次。

## 0.3.12-candidate.2 - 2026-10-15（候选编号 0.3.12.2，未正式发布）

- 修复 Dreaming 普通说明超过 2048 Token 或包含类似 XML 的工具文本时被提前取消的问题；真实原生工具调用可继续执行。单次响应仍有 32768 Token 上限，超限不自动重试。
- 完成后的总结请求沿用单次响应上限，不再额外限制为 2048 Token。

## 0.3.12-candidate.1 - 2026-10-14（候选编号 0.3.12.1，未正式发布）

- 修复 Dreaming 目录新页未计入进展、历史压缩后反复重读的问题：持久保存页覆盖，并在每次请求重建当前批次、必要概览、已读范围和失败写入断点；新页计入进展，重复页不计。
- 补全目录写入参数结构，拒绝嵌套 operations 和缺失 kind，并向 Agent 返回可修正的字段错误。
- 文字回复未完成批次时暂停，停止自动催促及失败请求自动重试；流式回复超过约 2048 Token 的普通说明或出现文本伪工具调用时取消当前请求，不限制整轮时长。
- 暂停原因与已完成批次/已保存修改显示在专属会话。新一轮创建新会话，继续沿用本轮会话与精简工作上下文，完整轨迹保留供查看。

## 历史候选 0.3.14 - Unreleased

- 修复 Dreaming 在真实 Cordis 插件上下文访问 sessions 未声明注入而立即暂停：通过可选服务查询完成目录路径解析与 flush，保持旧宿主可加载。
- 新增真实 ctx.plugin() 挂载回归，覆盖启动、暂停、打开宿主历史、继续与卸载；不再仅通过根 Context 验证。

## 历史候选 0.3.13 - 2026-10-14 (安装候选)

- 修复 Dreaming 专属会话缺少工作区 cwd，导致 DeepSeek Harness 历史接口返回 session/not-found；从对应活动或持久化普通会话恢复真实路径。
- 打开前 flush 会话；旧无路径会话给出重新开始的提示，保留已写入目录与旧日志。新增真实宿主历史接口回归。

## 历史候选 0.3.12 - 2026-10-14 (安装候选)

- 新增目录页 Dreaming Agent：使用独立的 DeepSeek Harness 会话按批整理章节、小节、Event 归属与带来源的总览/经验；提供进度、暂停、断点继续和终止。
- Dreaming 独立检索与只读取证复用 Core，避免创建用户聊天证据批次或修改 Block 展开、衰减及记忆权重；通过持久化认领和来源版本校验拒绝并发覆盖及迟到写入。
- 目录页增加“AI 会看到的目录”浮窗，完整展示实际默认注入文本；移除占用主页面空间的说明。Dreaming 运行详情直接打开真实 DSH 会话。
- Dreaming 增加连续无进展和每批 64 次成功提交后的暂停边界，支持人工继续；完整计量实际模型请求，拦截请求不计消耗。
- 大 Event 分页使用稳定序列化与内容版本断点，重启后可靠恢复；完整来源读取后才允许完成批次。

## 0.3.11 - 2026-10-14

- 修复长期记忆的知识图谱与事件时间线工具栏在窄设置面板中挤压搜索框的问题；统计移至下方，按钮按可用空间换行。
- 简化节点与关系统计，关系总数与当前搜索、类型/标签筛选和归档过滤采用相同节点集合，保留部分显示与全部显示的区别。
- 反馈与联系的第二、第三步统一在步骤条下方提供“← 上一步”；返回保留输入、附加信息勾选及已检查的报告快照。

## 0.3.10 - 2026-10-13

- 修复首次登录尚无工作区记忆时出现“知识图谱更新未完成 · 0/0 Events”的误报警。
- 图谱展示统一统计有效的普通 Events 与 Agent Events，过滤无有效来源的历史任务；不修改历史记录或调度行为。
- 隐藏零分母和越界的图谱进度比例，保留真实处理与失败提示；补充真实 MemoryPage 浏览器回归。

## 0.3.9 - 2026-10-11

- 暂时封存 GitHub 反馈工具、提示和 UI 入口，保留相关实现供恢复；反馈联系邮箱改为 jiahongcheng61@gmail.com。
- 反馈页改为“描述问题 → 检查报告 → 邮件发送”，前后切换保留输入，复制和下载使用已经检查的报告快照，明确提示尚未发送。
- 联系作者提供可复制邮箱和邮件唤起失败时的手动操作提示；修复历史草稿中的非法 Unicode 编码、标题截断和草稿保存异常处理。
- 保留 0.3.8 已发布的后台调度索引、FTS 增量维护、任务续租和有界恢复修复，以及 0.3.7 的长概要修复。

## 0.3.8 - 2026-10-11

- 修复 #128 后台 Worker 空闲时持续加载所有 namespace 历史记忆的问题：通过可重建的 SQLite 任务调度索引发现到期工作，同进程新任务主动唤醒，跨进程和重启后继续可靠发现；保留 Summary、Extraction、Graph、Topic、历史整理额度及独立 Profile Maintenance。
- FTS 初始化改为按需检查和增量修复；未修改的历史消息不重复标记 dirty。调度索引重建对损坏 namespace 持久退避，避免阻塞健康任务；只有待封存原始消息的 namespace 也能恢复处理。
- 长模型任务持续续租；处理缓存中的过期租约前读取同 revision 的真实租约状态，防止跨进程误恢复。冲突重试保持退避，尝试次数耗尽后停止自动调度。
- 调度索引记录派生规则版本；Topic/Graph 的版本化恢复规则变更时，仅重新排队命名空间键并分批重建，避免旧空闲索引漏掉应恢复的任务，正常打开不反复重建。

## 0.3.7 - 2026-10-09

- 修复 #119：Topic 概要正文使用统一的 1000 Unicode 字符硬上限，提示词建议通常 300～600 字符；完整事件归类优先，按需生成概要，不复述存储层继承的有效旧概要。
- 删除未成功保存的违规概要草稿的强制补写规则，兼容并清理旧修复要求；合法空概要可以完成，但遗漏 Event、伪造来源或破坏已有记忆仍被拒绝。
- 复用版本化恢复机制，为受影响且仍有效的旧失败任务提供一次有界重试周期；不重置无关任务、不重复处理已完成 Event，重启不无限恢复。
- Topic 独立输出预算不受普通 defaultMaxTokens 限制，仅按已知路由上下文容量收缩；配置异常归类为 Provider 失败。原 finishReason=error 的根因仍需实际运行日志确认。
- 同步中英文 DSH 文档，补充长度边界、低默认预算、多 Event、持久化保护、恢复与诊断回归测试；真实模型合法率未测量。

## 0.3.6 - Unreleased

- #119 再次复审：修复约束与持久化共用按内容、类型、标题及来源集合去重的规则；复制合法段落或调整字段/来源顺序不能凑够替代数量，并在最终节过滤、去重后的待保存结果上再次校验，失败不提交任何进度。

- #119 复审修复：一旦观察到不合格 overview，记录合法来源、类型及必要替代条目数，在结构化重试、任务重试、重启和拆批中继续校验；删除错误段落、换掉来源或清空数组不能冒充修正。旧字段失败没有段落信息时要求至少一个合法替代，首次正常空 overview 仍合法，不保存模型原文。
- 已解决的 Topic 失败保留原失败历史并标记 superseded，退出 Dashboard 当前故障、目录失败详情及重试入口；普通投影、增量和 Section Backfill 共用当前未完成工作判断，部分已成功批次的人工重试只处理剩余 Event。

- 修复 #119 的 Topic 字段校验反馈：区分概要正文为空、纯空白和超长，返回安全字段位置、实际字符数及限制；Schema 与语义校验失败均向模型反馈具体错误，完整结果通过校验才提交，不裁剪或伪造内容。
- 首次升级打开 writer 时，用独立持久化 Recovery Version 为当前有效、仍有未完成工作的 Topic 终态失败任务自动开启一次新的最多三次尝试；已成功或来源过期的工作不重跑，重启及重复初始化不重复恢复，仍遵守历史额度、租约和版本保护。
- 历史整理状态按实际进度展示：失败时明确显示“部分完成”及剩余数量，恢复排队和运行时显示整理中，所有当前工作成功后才显示完成；保留诊断和人工重新整理入口，旧数据库及无 diagnostics 的任务兼容。
- 修复 [#125](https://github.com/diqierjia/StrataGate-AgentMemory/issues/125)：`memory_search_events` 搜索无来源块编号的主动 Event 时返回 `undefined`，被 DSH 无损 JSON 输出校验拒绝的问题；缺失的可选字段不生成属性，保留有效 Event、排序和证据引用。完整检索返回通过 DSH JSON 规则后才登记证据批次，失败不留下未解决批次或覆盖已有批次。

## 0.3.5 - Unreleased

- UI 明确标注裁剪后的默认目录仅含部分内容，在摘要末尾提供“查看完整目录”，可定位并展开全部章节的小节导航，不自动读取事件或展开总览。
- 默认记忆目录加入 Chapter 下的 Section 标题，继续保留章标题和 description，不注入 `.0` / overview 正文。目录始终限制在 400 个估算 token 内；超限时保留分类、分页和展开入口，先展示章信息，再逐轮补充各章的小节标题。
- 默认目录单独读取时复用活跃 Memory 或使用只读存储，不启动迁移、派生任务、模型调用或记忆强化。正常 prompt 组装先计算 Auto Context，再生成目录，最终注入仍为目录在前，冷启动不再重复完整读取 Memory。
- 自动上下文在读取 Block 和检索 Event / Graph 前检查外部 namespace revision，版本变化时刷新缓存；独立 writer 新增或遗忘的 Event 能在同轮自动上下文和目录中一致生效，无更新时继续复用快照。

## 0.3.4 - Unreleased

- 为 Topic Projection 提供独立的 32,768 token 输出请求上限；根据宿主公布的 context window 保留输入和余量，每次 payload 声明的预算与实际请求一致，包括结构修复和 reasoning fallback。
- 区分输出截断、JSON/schema、语义校验、超时、provider/worker 和来源失效等失败，保留安全原因码及运行元数据；不保存模型原文、reasoning 或 Event/Topic 正文。
- 仅在明确 `finish=max-tokens` 时有限拆批，不裁剪事件证据；失败任务仍遵守退避、历史额度和来源版本检查。目录和通用任务入口都可手动开启新的任务周期，重启后可靠保留，旧任务结果不再生效；升级不会自动复活历史终态失败任务。

## 0.3.3 - Unreleased

- 将小节成员关系与总览证据分开保存；总览可以为空，所有新整理事件仍有真实小节归属。保留非本批事件的多重归属，重分类移空小节时清理其旧总览，Agent 可读取有界小节索引并按需分页。
- 升级后首次 writer 打开时，定向补归类已整理但没有小节归属的旧事件，包括此前候选包保存的数据；保留原章节、已知归属和有效总览，不改事件事实。任务及迁移标记持久化，重启不重复排队，沿用全库每 10 分钟最多 2 个历史任务的额度、有限重试和人工重新整理入口，新增事件仍优先。
- 补归类按“章节、事件、来源版本”隔离任务及失败：某章等待重试或重试耗尽不阻止其他章补齐同一事件。进度保留未完成及失败的小节关系数；仅剩终态失败关系时显示失败与重新整理入口，不误报全部完成或持续处理中。

## 0.3.2 - Unreleased

- 优化 Event Extractor：更敏感地保留有独立用途的用户信息，保守判断 session/project/user 范围，减少 Agent 操作流水账，并保留已验证的根因、限制和结果。
- 收敛原子事件标题，约束历史关系锚点；同次提取的精确重复事实合并来源并保留首份目录提示，不重写或重新提取旧 Event。
- 增加可选 catalogHints 和 extractorVersion，使用兼容 schema-12 的 metadata 旁表持久化。目录提示仅用于导航，Element/Graph 事实投影输入均物理排除这些 metadata。
- 将模型输出的 scope 设为必填枚举；遗漏或非法值触发有限结构化重试，避免临时要求静默扩大为项目长期记忆。

## 0.3.1 - Unreleased

- 修复 #113：明确 Graph canonical name 的来源是 Event ID 字符串数组，aliases/tags 才使用 `{ value, sourceEventIds }[]`。严格 schema 校验前，仅将 value 与实际 node.name 完全一致、字段与来源类型合法的对象数组归一为 name 来源；不匹配或异常结构仍拒绝，重试提示指出具体字段，原有 supplied Event 边界不变。
- 升级后首次配置 Graph projector 的 writer 打开命名空间时，仅为匹配旧 name schema 错误完整签名、来源均可暴露的终态失败 Graph jobs 排队一次有限重试周期；复用原 job 和后台 worker，持久化恢复标记，重启不反复清零。已完成、无关失败、遗忘/归档来源的 jobs 不自动恢复；无需手改 SQLite，原有人工 retry 入口保留。

## 0.3.0 - 2026-10-06

- 将同名总览归为同一节：`.0` 保留各段独立来源的总览，`.1~N` 按来源去重并集分页；节身份不随新段落变化，浏览不写库、不增加模型调用。
- 小节按来源在章节成员中的最早位置排序，同位置由稳定节身份决定；模型把新总览放在前面时，已有小节编号仍保留，新事件形成的节追加。
- 将主题明确为长期大章节，章内支持具名小节；候选匹配结合有界成员线索，同名候选复用，避免按单个子功能或事件不断建章。
- 升级第 3 代主题整理器：节按长期类别归纳，同类缺陷、版本与处理状态进入同一节；第 2 代目录按历史额度重新整理，保留有效章的 ID、名称、成员顺序与创建时间，事件事实及全库预算不变。第 1 代碎章及无效旧派生语言仍退休。
- 增加失败历史批次的定向“重新整理”入口，校验来源及目录版本，排队为新的有限重试周期；重启继续、重复点击不重复排队，仍遵守每 10 分钟最多 2 批的历史额度。

- 升级长期记忆机制：默认提供精简的主题目录，支持按需展开主题概览，并通过 `memory_list_topics`、`memory_expand_topic` 和 `memory_search_events(topic_id)` 导航到真实事件。
- 主题与概览是可重建的导航层，事实依据仍来自 Event 与原始消息；浏览目录不产生证据批次，也不强化记忆，实际使用仍经过原有证据评估与采用流程。
- 兼容旧 schema-12 数据库。首次 writer 打开时冻结已有事件作为历史初始化集合，新命名空间立即完成空初始化；此后新增事件独立按增量整理，只读打开不迁移或写库。
- 历史整理按批进行，全库共享每 10 分钟最多 2 个历史任务的持久预算；新增事件优先，重启后继续未完成历史任务，已完成批次不重复处理。
- 校验所有生成来源的版本，来源修改、遗忘或归档后立即隐藏过期派生内容并拒绝迟到结果；稳定复用主题 ID，限制失败重试，避免失效主题或失败任务形成重复模型调用。

## 0.2.97 - 2026-10-05

- 修复 #107：显式检索批次须在最终回答前完成证据评估与 `memory_record_use`；遗漏时先完成收尾，再生成完整用户答案，避免内部批次状态成为最后一条回答。
- 补答通过真实 DSH 消息事件确认非空用户可见文本，拒绝空内容、仅推理和可识别的截断结果；最多三次尝试后明确失败，补答期间禁用工具，下一轮恢复。
- 修复 #108：Profile 支持默认地点、原有常驻城市及当前所在城市。临时旅行或出差城市跨会话保存到用户修改或清空，不自动覆盖稳定地点；未指定地点时优先当前城市，再参考默认地点。
- 地址设置显示“常用地址”“常驻地址（未说明时默认地址）”“当前所在城市（临时）”，移除原地点说明；旧画像数据保持可读，原有常驻城市有值时仍可查看和编辑。
- 保留 Evidence Gate、仅采用证据才强化的规则及 Profile 原有授权机制；不包含 Topic/目录检索方案。

## 0.2.96 - Unreleased

- 修复 #102：模型输出或历史数据中的异常 EventTemporal 字段不再导致记忆检索及后续长期记忆提取失败。
- 在事件解析、写入、SQLite 读取、快照恢复及检索边界统一校验字段形状，丢弃无法安全解释的字段，保留事件与来源；合法字段值和顺序保持不变。
- 本次为 0.2.x bug 修复候选，不包含已撤回的主题聚合、主题目录和主题检索机制。

## 0.2.95 - Unreleased

- Clarify the DSH `memory_search_events` tool description: search historical facts, decisions, plans, changes, preferences, outcomes, and timing with focused, distinctive queries; treat compact results as candidates and expand Events when needed to verify details.
- State explicitly that `rankScore` indicates retrieval order, not confidence or factual accuracy. Preserve the parameter structure, other tool descriptions, memory protocol, retrieval behavior, and WorkBuddy.
- Verify the approved tool and query descriptions and complete parameter JSON Schema through the final DSH tool registry.

## 0.2.94 - Unreleased

- Simplify the DSH main-agent memory protocol by removing tool-level batch, citation, and memory-merge details while retaining the six Block layers, evidence-gated use, adopted-evidence reinforcement, and Profile consent boundaries.
- Clarify when to search history outside the visible conversation, Event/Graph responsibilities, automatic memory versus explicit retrieval, evidence sufficiency, and targeted follow-up retrieval without repeating failed searches.
- Verify the complete approved protocol in assembled system prompts, including session-scoped and activated-memory contexts. Tool descriptions, runtime behavior, and WorkBuddy remain unchanged.

## 0.2.93 - Unreleased

- Support the complete DeepSeek Harness `0.2.0` version family: all Alpha, Beta, RC, and stable releases (`>=0.2.0-0 <0.2.1-0`), without listing individual prereleases as installation requirements. Preserve the previously supported DSH versions.
- Keep the startup guard aligned with the installation range, retaining checks for mixed DSH runtimes and incompatible Cordis/Schemastery patch lines. Use producer-owned message sources throughout DSH `0.2.0` so native V4 Session checkpoints and steering messages remain valid.
- Require the three host-owned Session Format peers to match the DSH `0.2.0` core version, rejecting mixed or missing codecs before migration; retain earlier hosts' compatibility rules. Fix the installation verifier's failure-probe host flag and directly pin its app-boot development dependency.
- Pin development dependencies to DSH `0.2.0-rc.2`, add rc.1 and rc.2 to the Linux/Windows compatibility matrix, and update installation verification and version-boundary/V4 persistence regressions.
- 支持整个 DeepSeek Harness `0.2.0` 版本族，包含全部 Alpha、Beta、RC 和正式版；安装声明与启动检查统一采用 `>=0.2.0-0 <0.2.1-0`，无需为同属 `0.2.0` 的新版本逐个发布插件更新。保留旧宿主支持，修正新版消息来源格式，并更新兼容性测试。

## 0.2.92 - Unreleased

- Make Event extraction atomic, self-contained, and source-grounded, with descriptions for all eight core fields; remove Event narrative and confidence from extraction, retrieval, projection input, and UI/API output.
- Restrict extracted historical Event relationship IDs to the timeline supplied for that extraction call, including supersession, across all integrations and custom extractors.
- Keep legacy SQLite columns readable and strip retired fields from loaded Events and snapshots. Saving rewrites those legacy columns to summary and confidence 1; downgrading after a save does not restore the original narrative/confidence values.

## 0.2.89 - Unreleased

- Accept coherent DSH 0.1.7 hosts from rc.1 through the stable 0.1.7 release, including rc.2, without pinning every internal DSH package to one prerelease.
- Keep runtime checks for mixed DSH packages and incompatible Cordis or Schemastery versions; test rc.2 in the compatibility matrix.

## 0.2.87 - Unreleased

- Let the agent record durable long-term memories through `memory_remember`: each recording is written into a new isolated `agent_events` pool (schema v12) that mirrors the Event model, gets a synthetic `agent-memory:` provenance block, and projects into the Knowledge Graph.
- Resolve duplicates and conflicts before writing: exact and near duplicates reinforce the existing card, ambiguous overlap gets one synchronous model adjudication reusing the external-memory decision contract (add/merge/supersede/conflict/ignore with a non-destructive low-confidence downgrade), and clear-new facts write without a model call.
- Merge agent-recorded Events into retrieval through per-pool top-k lanes: the passive and agent pools are ranked independently and fused with weighted RRF, keeping `source: 'agent-recorded'` cards, cross-session persistence, and the `/api/stratagate/agent-memories` view; `agentMemoryRetrievalWeight` tunes the agent lane's share (0–5, default 1) and `agentMemoryEnabled: false` disables and unregisters the feature.

## 0.2.86 - Unreleased

- Register the chat memory tail with a stable list slot ID on DSH `0.1.7-rc.1` and derive its citation data from owner props, while retaining the older chain slot path. This also allows the StrataGate Settings section to finish registering. Chat citation registration now degrades independently with a console warning if the optional host slot fails, keeping Settings available.

## 0.2.85 - Unreleased

- Add explicit support for DSH `0.1.7-rc.1` and its host-provided runtime package family, including Cordis `4.0.4` and Schemastery `3.18.4`.
- Adapt the in-chat settings controls to DSH's profile-backed config forms while retaining the earlier settings service on supported older hosts. Keep the live reasoning-effort preference effective without restarting the plugin.
- Validate the legacy citation bridge as a V1 Session generation before DSH continues its V4 migration; preserve the original V0 log and its recovery receipt.
- Extend the compatibility matrix and clean-install smoke checks to the 0.1.7 host.

## 0.2.84 - 2026-09-25

- Clarify the Block Summarizer's L0-L2 layered memory output, source attribution, uncertainty, and length guidance.
- Use a high-recall `shouldExtract` pre-screen so plausible long-term Events reach the Event Extractor, and describe L0 tags as topical labels for rapid recognition.

## 0.2.83 - 2026-09-24

- Move Persistent Profile to a compact primary tab with grouped, single-field editing.
- Keep the visible Profile current with lightweight polling, and reject stale same-field Settings saves without overwriting Agent or maintenance changes.
- Add an independent visible reasoning language preference alongside the final answer language, with nine fixed Profile fields and no change to the overall budget.

## 0.2.82 - 2026-09-23

- Add a global, eight-field Persistent Profile that enters every model call without retrieval, with one-field Settings and `memory_profile_update` edits.
- Track Profile changes in SQLite and safely compress existing Profile wording in a bounded background maintenance pass.

## 0.2.81 - 2026-09-23

- Bound Event extraction history to eight relevant and four recently formed Events, excluding forgotten and archived memory while keeping superseded history eligible.

## 0.2.79 - 2026-09-22

- Keep background Block summary, Event extraction, and Graph projection jobs pending without consuming attempts until the selected DSH model adapter is registered, then resume them immediately after adapter updates.
- Retry a raced `NO_ADAPTER` model call once outside Core's existing three-attempt task budget, while preserving the normal terminal behavior for genuine model failures.

## 0.2.78 - 2026-09-21

- Derive Block summaries and Events from a provenance-preserving compact view of L5 messages, omitting large code and bounding oversized tool payloads while keeping full raw evidence in L5.
- Preserve message IDs and validate Event `sourceMessageIds` against the original L5 block so tool-trace compaction does not weaken evidence links.

## 0.2.77 - 2026-09-21

- Treat an empty Event store as a normal idle state so a new workspace no longer reports an unfinished 0/0 knowledge graph update.

## 0.2.76 - 2026-09-20

- Track exact Event provenance for Graph node names, aliases, and tags without changing the SQLite schema, while keeping legacy metadata visible only when every potential source remains exposable.
- Prevent hidden or unproven metadata from driving entity merges, citations, adopted names, search claims, or automatic context, and keep canonical-name evidence attached to the name it actually supports.
- Preserve Fact key/value record boundaries during temporal search so unrelated fields cannot manufacture a current or historical match, while retaining legitimate multi-record queries.

## 0.2.75 - 2026-09-20

- Keep feedback reports local until the user explicitly pastes them, with stronger credential redaction, privacy-safe Issue URLs, and reliable clipboard, popup, and draft-save failure handling.
- Make feedback draft updates patch-oriented while treating an explicitly saved Markdown body as authoritative, so stale structured fields cannot reappear.
- Patch only real top-level canonical feedback sections while preserving custom sections, inline lookalikes, indented code, and correctly matched fenced code blocks.

## 0.2.74 - 2026-09-19

- Separate short-term memory compression, long-term memory extraction, and knowledge graph update status in the UI.
- Distinguish active, retryable, terminal-failed, completed, and blocked work while preserving manual retry behavior.
- Add stage-specific status details and regression coverage for memory derivation and graph migration states.

## 0.2.72 - 2026-09-18

- Filter the Event timeline by query, time, entity, type, and status before calculating totals and applying pagination, and refresh the view when filters change.
- Isolate DSH compatibility dependency trees and verify package peers against the matrix-specific host root.

## 0.2.73 - 2026-09-18

- Add exact runtime-family support for `@deepseek-ai/dsh@0.1.6-alpha.1`, including its `0.1.6-alpha.1` internal DSH and Session Format packages while retaining the existing 0.1.2 and 0.1.5 families.
- Strengthen the clean-install smoke gate with a live StrataGate Admin API probe, 0.1.6 legacy Session migration coverage, and a negative case proving that an optional plugin load failure cannot pass merely because the DSH Web Host remains available.
- Document that DSH 0.1.6's official DeepSeek profile may enable Session Log request metadata by default; StrataGate does not change that host setting.

## 0.2.71 - 2026-09-15

- Persist each Event's formation turn in the version 11 storage schema and migrate reliable legacy values from source Blocks, keeping decay and adoption trajectories anchored to the Event's actual lifecycle.
- Rework Event details and citations with formation metadata, participant links and aliases, complete adoption history, and responsive memory-weight trajectory charts with explicit provenance and fallback states.
- Harden release-candidate verification by staging temporary packages outside the repository and deriving the tarball name and supported DSH compatibility matrix from the package manifest.

## 0.2.70 - 2026-09-14

- Bound Graph and Element projection work to three attempts with persisted retry timing, terminal failure handling, pending-job priority, and upgrade-safe normalization for existing Graph jobs.
- Reduce Graph projection context and output size, avoid duplicate Graph calls after max-token truncation, and make scheduled versus terminal retries explicit in the status UI.

## 0.2.69 - 2026-09-14

- Clearly separate retrieved memory candidates from the memories actually adopted by an answer, with compact answer-tail citations and an expandable, Evidence Gate-aware multi-round retrieval trace.
- Add per-Event memory weight trajectories derived from persisted adoption receipts and the existing decay function, including current weight and adoption metrics without treating retrievals as reinforcement.

## 0.2.68 - 2026-09-14

- Reorganize Advanced Settings into Memory Configuration, Data & Storage, and Runtime & Diagnostics while keeping existing memory and diagnostic behavior intact.
- Show the resolved StrataGate data directory with copy and native folder-open actions, and move raw data, system status, usage records, and background jobs into their corresponding advanced sections.

## 0.2.67 - 2026-09-13

- Repackage the current StrataGate settings and display-preference release as npm package `0.2.67`.

## 0.2.66 - 2026-09-13

- Add an independent persistent-memory worker that scans every namespace and consumes pending or retryable Summary, Event extraction, and Graph projection jobs without waiting for a new host session event.
- Reorganize More into four clear entry points, add global display-only controls for short-term Block and retrieval status UI, surface diagnostics under Advanced Settings, and show the package-derived plugin version with lightweight contribution links.

## 0.2.65 - 2026-09-13

- Replace the competing processing and retry banners with one actionable memory status bar. Normal background organization now uses the informational accent, retryable failures use warning styling, and concurrent states share one summary and status-page entry point. The detail view groups work by conversation and turn range, shows the three user-facing processing stages, keeps technical job data collapsed, and counts distinct conversation fragments instead of internal jobs.
- Keep that detail view truthful during an in-place upgrade: recover visible conversation progress from legacy Block data when possible, identify client/server version skew, and show an explicit restart notice instead of incorrectly claiming that no work is pending.
- Include the plugin version in Dashboard cache validators so an upgraded server cannot return `304 Not Modified` for a page still holding the previous version's status payload.

## 0.2.64 - 2026-09-12

- Separate read-only status refresh from targeted retries for Block Summary, Event extraction, and Graph projection failures. The status page now lists every failed job with Block and conversation context, attempt count, retry time, latest error, visible progress, and durable retry failure feedback.
- Render short-term Block status only in the corresponding turn's content flow, so it scrolls with the conversation instead of staying beside the composer. Add a persistent Advanced Settings switch that hides this status without disabling memory capture or processing.

- Run folded-turn ingestion on a count-triggered, per-session background drain so the agent hot path does not wait for memory processing; failed and unprocessed turns are restored in order for a later retry or explicit flush.
- Keep automatic long-term-memory retrieval keyed to the current user message, avoiding stale previous-topic context during consecutive conversations.
- Safely omit `reasoningEffort` when model capability lookup fails or times out, and emit at most one fallback warning for each provider/model route.
- Expose the `structuredReasoningEffort` policy (`auto` or `force-off`) as a user-editable plugin setting; unsupported `force-off` requests fall back to the model default instead of failing the structured call.
## 0.2.63 - 2026-09-12

- Make DSH core packages host-provided optional peers instead of profile-local plugin dependencies. The new `stratagate-dsh-repair` command moves old hoisted DSH peers into a recoverable profile backup before startup; a bootstrap resolver then forces StrataGate's own imports through DSH's installation-owned fallback, and unsupported host families fail fast with a diagnostic.
- Add a safe bridge for v0 sessions containing the retired `stratagate/memory-citations` event. The original generation remains untouched and a recovery receipt records both hashes.
- Formally test the complete DSH `0.1.2-rc.1` family and DSH `0.1.5-rc.1` with its real `0.1.5-rc.2` internal dependency tree.

## 0.2.60 - 2026-09-08

- Queue folded turns on a count-triggered, per-session background drain with bounded retry backoff; failed batches are restored in order and a later explicit flush can recover them without losing memory.
- Keep automatic long-term-memory retrieval keyed to the current user message, avoiding stale previous-topic snapshots during consecutive conversations.
- Expose the structured reasoning-effort policy through DSH settings; capability lookup failures now conservatively omit `reasoningEffort`, and each provider/model route emits at most one fallback warning.
- Migrate the Web client from the removed `conversationEvents` service to `uiConversation.events`, adopt the new Session snapshot and branded-sequence APIs, and update the supported DSH baseline to `0.1.2-rc.1`.

## 0.2.59 - 2026-09-08

- Increase the structured model task timeout from 45 to 120 seconds so Event extraction has enough time to complete on slower model responses.

## 0.2.58 - 2026-09-08

- Style normal background memory processing with the blue informational theme, reserving red danger styling for failures.

## 0.2.57 - 2026-09-07

- Add an explicit per-Block Summary retry action for terminal failures, with affected conversation details and separate status refresh behavior.
- Give a user-requested retry a fresh bounded attempt budget while preserving raw conversation data and continuing downstream Event and graph processing only after Summary succeeds.

## 0.2.56 - 2026-09-07

- Include Block Summary failures in workspace alerts, diagnostics, and system status instead of reporting only downstream Event and graph jobs.
- Derive pending Block presentation from the persisted Summary job and use workspace-wide job totals on the system page.

## 0.2.55 - 2026-09-07

- Let the Agent unobtrusively offer a local feedback draft only for clear, unresolved or disruptive errors, with conversation-scoped suggestion and problem deduplication enforced by prompt instructions.
- Keep direct feedback requests authorized and unrestricted while preserving fact-only drafts, manual submission, and clickable local draft links.

## 0.2.54 - 2026-09-07

- Keep the virtualized short-term memory dock below host overlays and hide it while a visible modal dialog such as Settings is open.

## 0.2.53 - 2026-09-06

- Prefer DSH's formal `settingsNavigation.openSection()` contract when opening a prepared Feedback draft, while retaining the HTTP deep link and legacy rc.7 navigation as compatibility fallbacks.
- Replace the permanently expanded Feedback report with an on-demand preview that shares the exact generated report snapshot used for clipboard copy and diagnostic download.
- Keep real report, diagnostic-log, and Memory content out of GitHub Issue URLs; prefill only the optional title and a generic HTML paste instruction.

## 0.2.52 - 2026-09-05

- Return the Feedback draft entry as an absolute link derived from DSH's active Web server port, so the conversation renderer keeps it clickable without hardcoding a port.

## 0.2.51 - 2026-09-04

- Keep the current short-term memory Block status visible above the composer when its inline conversation row scrolls out of view or is virtualized away.
- Show explicit open, sealed, compressing, failed, and compressed L0-L5 states while retaining expandable read-only Block details.
- Reuse the existing session feed and browser observers without adding runtime dependencies.

## 0.2.50 - 2026-09-04

- Keep feedback reports local instead of placing diagnostics, conversations, errors, or graph data in GitHub Issue URLs.
- Add a read-only report preview, clipboard-assisted Issue flow, and an exact UTF-8 diagnostic file download fallback.
- Build diagnostics from explicit field allowlists, preserve full report content, and warn users before including potentially private memory data.
- Add the local-only `feedback_prepare` Agent tool and editable AI-assisted feedback drafts in the feedback page.
- Detect explicit StrataGate tool, ingestion, Block derivation, and Graph projection failures for a short temporary Agent suggestion, with a global five-day cooldown.
- Keep GitHub submission manual and keep diagnostic logs and memory data opt-in.

## 0.2.48 - 2026-09-03

- Replace the short-term memory floating inspector with quiet, expandable Block status rows inside the conversation flow.
- Show persisted Turn ranges, the actual decayed L0-L5 layer, server-estimated layer token sizes, and read-only layer previews for the active DSH session.
- Restore sealed Block rows when the lightweight client consumes the paginated `memories(kind=blocks)` response.

## 0.2.47 - 2026-09-02

- Package the ordered, per-tool retrieval visualization as a new installable DSH release.

## 0.2.46 - 2026-09-02

- Show a quiet, expandable answer-tail retrieval receipt when matching memories were checked but not adopted, preserving each tool retrieval as an ordered group with separately numbered candidates and on-demand source details.

## 0.2.45 - 2026-09-02

- Show a quiet answer-tail retrieval note when matching memories were checked but not adopted.

## 0.2.44 - 2026-09-02

- Fuse BM25 and structured Event/Element relevance with the existing adoption-based time-decay ranking, without admitting irrelevant recent memories.

## 0.2.43 - 2026-09-01

- Simplify adopted-memory citations with compact answer-tail summaries, collapsed related/source details, and explicit context-use labels.
- Render adopted Knowledge Graph references as focused neighborhoods and show all Block levels while highlighting only the adopted level.

## 0.2.42 - 2026-09-01

- Restore live assistant rendering on DSH `0.1.0-rc.7` by publishing memory-citation location data under the registered conversation kind.
- Derive answer-tail citations from supported `memory_record_use` tool call and result events instead of persisting an unsupported custom session event.
- Preserve read compatibility for legacy citation events while allowing migrated session history to replay without refresh-only failures.

## 0.2.41 - 2026-09-01

- Render program-owned Event, Knowledge Graph, and Block citations under the exact assistant answer that adopted them through `memory_record_use`.
- Preserve adopted evidence kind, source reference, Block level, and expansion state in durable usage audits and session history.
- Open citation details directly from the answer tail, including the selected memory content and its source conversation.

## 0.2.40 - 2026-08-31

- Make Knowledge Graph limits explicit, render the top 100 nodes by default, and let users reveal 100 more at a time.
- Add total-aware pagination for Events and Blocks in 40-item pages and usage audits in 100-item pages.

## 0.2.39 - 2026-08-31

- Preview external-memory imports without writes, skip exact duplicates deterministically, and ask the configured model to adjudicate Top-K local matches.
- Apply high-confidence decisions automatically while requiring confirmation only for low-confidence candidates.
- Commit imports atomically and support undoing a committed import batch, including affected Event relationships and derived projections.
- Keep model adjudication outside storage revision ownership, then reload and retry only the short idempotent commit so concurrent writes cannot fail a running import.
- Persist external-memory analysis jobs with per-candidate progress, recover malformed exports through a model fallback, and resume progress plus low-confidence review after reopening the import page.
- Keep import status polling alive across transient network failures, reload stale active namespaces before retry, and resume background adjudication from the latest SQLite revision after concurrent memory writes.

## 0.2.37 - 2026-08-29

- Seal each completed Block immediately with deterministic L3-L4 and permanent L5, while keeping model-pending Blocks out of decay and native-surface replacement until L0-L2 and Event processing both complete.
- Add persisted summary jobs, bounded exponential retries, and SQLite schema v9 migration so derivation failures cannot lose turns, receipts, or block later sealing.
- Resolve exact-model `reasoningEffort: off` support, fall back once on explicit rejection, cache negative capability by route, and bound structured tasks by output tokens and a hard timeout.

## 0.2.36 - 2026-08-28

- Make completed conversation turns per Block editable in Advanced Settings, persist it globally, and suggest an optional λ adjustment that preserves decay speed per turn.

## 0.2.35 - 2026-08-27

- Return compact Event, Knowledge Graph, and raw-memory search cards while keeping full details in expand tools.
- Rename tool-facing ranking output to `rankScore` and document that it is not confidence or factual accuracy.
- Filter relation-only Knowledge Graph matches, report matched fields, and preserve distinct same-name entity types.

## 0.2.34 - 2026-08-27

- Add explicit `session` and `namespace` scopes to block and raw-memory retrieval.
- Return namespace, thread, counts, and machine-readable empty reasons for block queries.
- Keep session namespace isolation and make open-tail and cross-thread empty results explainable.

## 0.2.33 - 2026-08-27

- Keep concurrent retrieval batches independently addressable through optional `batch_id` parameters on assessment and usage recording while preserving latest-batch defaults for sequential calls.
- Report every assessment rejection and aggregate all invalid usage refs with batch status, available refs, and adopted refs; zero-use audits now retain the real batch ID.

## 0.2.30 - 2026-08-25

- Add compact minus, slider, and plus controls to the Knowledge Graph for faster zoom adjustments.
- Synchronize the visible zoom control with mouse-wheel zoom while keeping button and slider zoom centered on the graph canvas.

## 0.2.29 - 2026-08-25

- Keep the long-term memory explorer fixed to the browser viewport by removing transforms from its animated content ancestor.
- Add regression coverage for the full-screen positioning contract.

## 0.2.28 - 2026-08-25

- Refine the DSH Memory UI with clearer brand, navigation, hierarchy, spacing, and interaction states while retaining native DSH theme tokens.
- Add restrained view, Block expansion, graph layout, detail panel, popover, and skeleton-loading motion with reduced-motion support.
- Improve keyboard focus visibility, active navigation semantics, meaningful mascot alternative text, and tactile hover and pressed feedback.

## 0.2.27 - 2026-08-25

- Add optional semantic Tags to newly projected Knowledge Graph nodes for search, filtering, and understandable group names while keeping Node Type unchanged.
- Detect dynamic communities with seeded, weighted Leiden using active edges, relationship density, shared Events, Node Type, and Tags; Tags only strengthen existing structural affinity.
- Render ephemeral Cluster compound nodes with Cytoscape.js and fCoSE for clearer separation, overlap avoidance, pan/zoom, and relationship highlighting.
- Keep existing graph snapshots untouched: the projector version is unchanged, no historical Events are requeued, and nodes without Tags continue to render and cluster normally.

## 0.2.26 - 2026-08-25

- Size Knowledge Graph nodes by their long-term importance using supporting Events, active relationships, sustained recent activity, and current-workspace affinity.
- Keep node sizing stable across search and type filters by deriving importance from the complete graph snapshot.
- Preserve selection as an independent outline and glow treatment instead of temporarily enlarging the selected node.

## 0.2.25 - 2026-08-24

- Send every sealed conversation Block through its current decayed L0–L5 representation instead of a fixed L0/L1/L2 checkpoint.
- Re-replace native DSH Block checkpoints when decay, a manual lift, or the global decay coefficient changes their active level.
- Keep the original surface range shadowed, the unsealed open tail and tool chain native, and automatic system context limited to activated cross-conversation long-term memory.

## 0.2.24 - 2026-08-24

- Make the Knowledge Graph and Event Timeline fill the plugin width instead of reserving a permanent detail column.
- Add lightweight node and event detail bubbles, including hover persistence for timeline previews and summary-first event rows.
- Collapse advanced filters behind a compact toolbar control and move complete relationships, evidence, and exploration into full-screen views.

## 0.2.23 - 2026-08-24

- Replace each newly sealed conversation range on the native DSH surface with its compressed StrataGate Block summary, allowing `deriveMessages()` to shadow the corresponding raw messages while preserving the append-only evidence log.
- Keep unsealed open-tail messages and their tool-call/result chains in native DSH history instead of serializing them into the dynamic system context.
- Restrict automatic dynamic context to activated long-term memory from other conversations, preventing current conversation content from appearing in both native messages and the system prompt.

## 0.2.22 - 2026-08-24

- Replace the visible Element-card long-term memory model with an Event-backed Knowledge Graph of stable nodes and directed edges.
- Add the Knowledge Graph / Event Timeline settings views, evidence navigation, canonical Event types, and stable participant node references.
- Rebuild legacy Event history in small, prioritized, persisted, resumable background batches with projector-version tracking.

## 0.2.21 - 2026-08-24

- Use the current DSH Workspace session list and latest persisted DSH titles as the conversation selector source of truth.
- Recover pre-thread legacy conversation boundaries from ingestion receipts and render mixed legacy Blocks as read-only virtual fragments without rewriting SQLite.
- Add More → Feedback & Support with privacy-safe diagnostics, opt-in logs and memory data, GitHub Issue/Feature Request links, and Discussion Q&A.
- Retry transient read-only browser fetch failures and identify the failed StrataGate endpoint in diagnostics.

## 0.2.20 - 2026-08-24

- Redesign Short-term Memory around a per-conversation oldest-to-newest Block distribution, a dedicated horizontal rail, sealed Block distances, and a distinct open Block state.
- Expand Blocks inline into ordered L0–L5 previews with current-level highlighting and viewport-level, scrollable full-content hover cards that are not clipped by Settings.
- Keep only one layer menu open, offer expansion only for deeper layers, and distinguish user, Agent, and legacy expansion markers.
- Migrate storage to schema v7 to persist the source of each Block lift without mislabeling Agent retrieval as a user action.

## 0.2.19 - 2026-08-23

- Make the global Block decay coefficient λ editable in Advanced Settings with `0.05` steps, immediate application to existing workspaces, persistence across restarts, and inheritance by future workspaces.
- Show actual workspace names instead of internal namespace hashes and rename the current-project label to current workspace.
- Unify the settings page branding as `StrataGate-AgentMemory`, restore the mascot, and show a right-aligned genuine memory-use count with a GitHub Star link.

## 0.2.18 - 2026-08-23

- Match the Memory settings UI to DSH's resolved light, dark, or system appearance through the official semantic theme tokens.
- Remove the independent dark palette so the plugin background and controls no longer differ from the surrounding DSH settings panel.

## 0.2.17 - 2026-08-23

- Define Block age as the per-session distance from the latest sealed Block, so open-tail turns no longer decay Block detail.
- Add the configurable `blockDecayLambda` setting with a default of `0.3`; smaller values decay more slowly, and values above `0.4` are not recommended.
- Migrate SQLite storage to schema v6 and convert legacy turn anchors to per-thread Block positions without deleting existing memory.

## 0.2.16 - 2026-08-21

- Isolate open tails, Block sealing, decay, and automatic Block context by DSH session while keeping Events and Elements project-scoped for cross-session recall.
- Migrate SQLite storage to schema v5 with optional thread ownership on raw messages and Blocks; pre-v5 Blocks remain unowned archival provenance instead of being injected into new sessions.

## 0.2.15 - 2026-08-21

- Disable reasoning for internal structured memory workers because the current DSH adapters do not map `tool_choice` to the provider request.
- Keep strict native tool-call validation with a legal JSON fallback for adapters that expose tools but not forced tool selection.

## 0.2.14 - 2026-08-21

- Force each internal structured worker to target its one required tool when the provider supports the OpenAI-compatible `tool_choice` request field.
- Preserve the active session's reasoning effort on auxiliary memory-model calls instead of silently falling back to the provider default.
- Add regression coverage for forced tool selection and reasoning-effort propagation.

## 0.2.13 - 2026-08-21

- Run block summarization, event extraction, and element projection through single-purpose native tool calls with strict argument schemas.
- Keep reasoning/text blocks as diagnostics only instead of parsing them as memory results.
- Report internal structured-worker failures with the expected tool name so they are not mistaken for memory search argument failures.

## 0.2.12 - 2026-08-21

- Inject the complete open tail, every sealed Block at its current decay-pointer level, and a bounded set of activated Events and Element facts before each main-model call.
- Build activation queries from the current user message plus the latest two open-tail turns, retaining BM25 as the relevance gate and fusing relevance with existing memory weights through RRF.
- Keep automatic context read-only with respect to adoption: it never calls `recordMemoryUse`, increments `mentionCount`, or changes `lastAdoptedTurn`.
- Require every explicit retrieval batch to finish with `memory_record_use`: selected evidence refs reinforce only their own cards once, while an empty list records a zero-increment receipt and allows the turn to finish.
- Enforce unresolved retrieval accounting at DSH's turn-stopping boundary instead of relying only on prompt compliance.
- Close namespace storage when pending-work initialization fails so a retry does not leak a SQLite handle.

## 0.2.11 - 2026-08-21

- Recover a namespace after pending-work initialization fails instead of caching a rejected runtime promise.
- Distinguish intentionally skipped extraction from Blocks waiting for extraction.

## 0.2.10 - 2026-08-21

- Keep readable memory data visible when one administrative read fails.
- Refresh the Memory UI automatically and distinguish waiting Blocks from active processing.
- Prevent persisted ingestion failures from turning concurrent administrative reads into transient HTTP errors.

## 0.2.9 - 2026-08-20

- Force element projection responses to be JSON-only and require changes for identifiable entities.
- Recover structured JSON after model reasoning text and validate required response fields before accepting it.
- Surface empty element projections with an explicit event-count diagnostic and retry historical skipped extraction jobs on startup.
- Show a red in-progress banner with a loading indicator while block, event, or element memory processing is active.

## 0.2.8 - 2026-08-20

- Increase model output and retry limits to 10,000 tokens.
- Normalize generated timestamps to UTC+8 and treat truncated extraction responses as failures.

## 0.2.7 - 2026-08-20

- Make extractor context target-first: target retains L5 evidence while neighboring blocks provide only L2 context.
- Add an explicit target source-message allowlist and reject empty extraction results as failed work instead of silently skipping them.
- Add a bounded `resumePendingWork({ retrySkipped: true })` path for repairing historical skipped extraction jobs.

## 0.2.6 - 2026-08-20

- Redesign the Memory UI around Long-term Memory, Recent Memory, and More for narrow DeepSeek plugin windows.
- Present Events as long-term memories, Elements as related-item details, and Blocks as recent memories without changing extraction logic.
- Add user-facing organization states, reassuring failure messaging, memory-first search, and responsive light/dark layouts.
- Move system status, usage audit, raw data, model responses, and advanced settings out of the primary experience.

## 0.2.5 - 2026-08-20

- Republish the successful-response history and diagnostics as a distinct installable package version.

## 0.2.4 - 2026-08-20

- Republish the complete error-retention and 10,000-token default configuration as a distinct installable package version.

## 0.2.3 - 2026-08-20

- Improve model JSON recovery for reasoning-only, truncated, BOM-prefixed, and explanatory responses.
- Include bounded raw-response diagnostics when extraction or projection parsing fails.
- Preserve complete failure details for copying while showing only a 500-character preview in the Memory UI.
- Raise the default memory model output budget to 10,000 tokens.
- Retain the five most recent successful memory-model responses per namespace for diagnostics.

## 0.2.2 - 2026-08-19

- Retry malformed or truncated model JSON once with a correction instruction and parse balanced JSON values safely.
- Change the DeepSeek Harness block size default from four to six turns while keeping `blockTurnSize` configurable.
- Redesign the read-only Memory UI with pipeline health, visible block cadence, responsive metrics, and failed-job diagnostics.

## 0.2.1 - 2026-08-18

- Make marketplace, npm, and README descriptions match common agent searches for user preferences, project decisions, cross-session memory, and source-traceable recall.
- Show a dismissible GitHub Star invitation after StrataGate memory has been used in three evidence-backed answers.

## 0.2.0

- Add a read-only StrataGate Memory page for namespaces, Events, Elements, Blocks, source messages, and usage audits.
- Persist the Evidence Gate decision and evidence references with each use receipt.
- Add package-content, clean-install, Node, and DeepSeek Harness compatibility checks.

## 0.1.0

- Initial DeepSeek Harness integration with automatic ingestion, retrieval, expansion, evidence assessment, and use-only reinforcement.
# 0.2.32

- Redesign external AI memory import as a two-step modal with the complete export prompt, one-click copy, JSON validation, and direct import.

# 0.2.31

- Add v2 external AI memory export/import flow with time-safe candidate parsing and Event adjudication support.
