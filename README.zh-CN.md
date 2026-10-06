<div align="center">

<img src="docs/assets/stratagate-avatar.png" alt="StrataGate Agent Memory 横幅" width="100%" />

# StrataGate

### 近期对话保留细节，远期记忆逐渐简化。

StrataGate 是 DeepSeek Harness 的跨会话记忆插件。近期对话保留细节，较早对话逐渐简化，需要时可以找回原文；重要决定、偏好和计划会整理为长期记忆，供后续会话使用。

[![CI](https://github.com/diqierjia/StrataGate-AgentMemory/actions/workflows/ci.yml/badge.svg)](https://github.com/diqierjia/StrataGate-AgentMemory/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/stratagate-dsh.svg)](https://www.npmjs.com/package/stratagate-dsh)
[![npm downloads](https://img.shields.io/npm/dt/stratagate-dsh.svg)](https://www.npmjs.com/package/stratagate-dsh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/diqierjia/StrataGate-AgentMemory?style=social&label=Stars)](https://github.com/diqierjia/StrataGate-AgentMemory/stargazers)
[![dshfind: StrataGate-AgentMemory — A 73](https://dshfind.com/api/badge/diqierjia/StrataGate-AgentMemory?lang=zh)](https://dshfind.com/zh/plugins/diqierjia/StrataGate-AgentMemory?ref=badge)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![欢迎贡献](https://img.shields.io/badge/%E6%AC%A2%E8%BF%8E%E8%B4%A1%E7%8C%AE-brightgreen.svg)](CONTRIBUTING.zh-CN.md)

[![dshfind](https://dshfind.com/api/card/diqierjia/StrataGate-AgentMemory?lang=zh)](https://dshfind.com/zh/plugins/diqierjia/StrataGate-AgentMemory?ref=badge)

[English](README.md) · [DeepSeek Harness 插件说明](docs/DSH.zh-CN.md) · [架构说明](docs/ARCHITECTURE.md) · [完整评测](docs/EVALUATION.md)

<strong>公开评测：</strong>在 LoCoMo 单个对话样本 `conv-26` 的 152 道题上，每个答案经过 10 次独立评审，平均判定正确率为 <strong>80.46%</strong>，Mem0 base 为 <strong>63.22%</strong>。[查看评测范围](#experimental-results)。

</div>

## 为什么选择 StrataGate？

1. **短期记忆：随对话推进逐渐模糊，需要时重新展开。**

   (1) **近期详细，远期简略。** 同一段对话保存为 L0–L5 六种详细程度的视图。随着后续对话积累，较早的记忆逐渐从完整对话变为关键事实、简短摘要和标题索引，减少历史内容对上下文的占用。→ [分层记忆](#layered-memory)

   (2) **展示变简，原始记录保留。** 完整的 L5 原始消息与工具记录始终保存。需要核对细节时，Agent 可以按需展开，找回当时的原话和上下文。→ [分层记忆](#layered-memory)

   ![短期记忆动画：Block 从 L5 逐渐简化到 L0，留在上下文中，并在需要时展开](docs/assets/short-term-memory-explainer-zh.gif)

2. **长期记忆：用事件线保留历史，用知识图谱整理当前状态。**

   (1) **事件记录“发生过什么”。** 对话中的重要决定、偏好、计划和变化会被提取为 Event，保留来源，并区分“什么时候提到”和“什么时候发生”，供后续会话查找和追溯。→ [事件卡](#event-cards)

   (2) **知识图谱表达“当前是什么状态”。** 根据历史事件，整理人物、项目、组织、工具和地点的当前信息及关系。新事件可以补充或取代旧状态，历史事件及其来源仍然保留。→ [当前状态图谱](#current-state-graph)

   (3) **长期权重也会衰减。** 随着对话推进，未被采用的记忆权重逐渐降低，影响检索与自动召回时的优先级；衰减后的记忆仍保留来源，可继续查证。→ [权重与采用强化](#use-only-reinforcement)

   (4) **支持迁移其他 AI 的记忆。** 导入内容可以转换为可追溯的事件，并用于更新知识图谱；原始导入内容仍会保留。→ [外部记忆导入](#external-memory-import)

3. **证据门：回答前先检查检索到的证据是否够用。**

   搜索结果相关，不代表足以回答当前问题。Agent 会判断证据是否充分；不足时继续搜索、展开事件或回查原始消息，仍无法确认时明确说明不确定性。→ [证据门](#evidence-gate)

4. **只强化实际使用的记忆。**

   搜索命中或自动带入上下文不会触发强化。只有被记录为最终答案实际采用的证据，才会增加采用计数、更新衰减起点；采用越多，之后衰减越慢，避免记忆仅因频繁被搜到就不断强化自身。→ [只强化实际使用的记忆](#use-only-reinforcement)

开始使用：→ [快速开始](#quick-start-deepseek-harness)

<a id="quick-start-deepseek-harness"></a>

## 快速开始：DeepSeek Harness

如果已经安装 DeepSeek Harness，请将 StrataGate 添加到你正在使用的 profile：

```bash
dsh plugin --profile web add stratagate-dsh
```

支持整个 DSH `0.2.0` 版本族：全部 Alpha、Beta、RC 和正式版（`>=0.2.0-0 <0.2.1-0`），同时保留此前支持的宿主版本。同属 `0.2.0` 的新版本无需因版本声明而等待插件更新。

重启该 profile，之后照常使用 DSH 即可。StrataGate 会自动记录主 Agent 已完成的对话，在后台生成可搜索的记忆，并在 **DSH 设置 → StrataGate-AgentMemory** 中提供记忆界面。

数据库默认保存在：

```text
DSH_HOME/stratagate/memory.db
```

移除插件不会删除数据库。截图、配置项、记忆工具和自动记录规则见 [DeepSeek Harness 插件中文说明](docs/DSH.zh-CN.md)。

上面的命令使用 `web` profile；如果使用其他 profile，请替换 `web`。开发者可直接查看[开发与文档](#code-entry-points)。

<a id="how-stratagate-works"></a>

## 它如何工作

![图 1：StrataGate 整体处理流程——记忆形成、自动激活、主动检索与证据判断](docs/assets/aaed14b0b43a76334008117f6ca104af.png)

1. **保存对话。** 若干轮连续对话组成一个记忆块（Block），保存为从索引到原文的六种视图。
2. **提取长期信息。** 决定、偏好、计划或变化被整理为长期事件（Event），保留时间与来源；知识图谱据此整理当前状态。
3. **回答时找回。** 插件自动带入少量相关记忆；信息不足时，Agent 搜索事件、图谱或原始消息，并判断证据是否够用。
4. **记录实际使用。** 最终答案选作证据的 Event 会记录为一次“采用”，用于更新长期权重。

自动召回目前最多带入 4 条 Event 和 4 个图谱节点，总预算约 900 tokens。当前会话另由分层 Block 和尚未封存的对话提供。

同时提供约 400 词元的记忆目录，说明当前空间记过哪些主题；大目录可分类分页浏览。Agent 按需展开有来源的主题概览，再检索真实事件取证。主题在后台用已有事件分批整理，查看目录不调用模型、不强化记忆。→ [记忆目录与主题整合](docs/MEMORY_TOPICS.zh-CN.md)

## 核心设计

| 机制 | 变化的内容 | 保留的内容 |
| --- | --- | --- |
| 短期记忆简化 | 旧 Block 默认使用哪个 L0–L5 视图 | L5 原始对话与工具记录 |
| 长期权重衰减 | Event 在后续召回中的优先级 | Event 历史及其来源 |

两者都随对话进度变化：短期按就绪 Block 距离计算，长期按对话轮次计算。放置几天本身不会触发这两种衰减。

<a id="layered-memory"></a>

### 1. 短期记忆：随对话推进逐渐简化，需要时重新展开

近期讨论通常需要保留完整细节，较早的对话则可以先以简短形式留在上下文中。StrataGate 为同一段对话保存多种详细程度的视图，并随着后续对话积累，逐渐减少旧对话默认呈现的内容。

![图 2：StrataGate 短期记忆——L0–L5 分层视图、展示衰减与按需展开](docs/assets/41fc676096d0a13337a1c03aaf8f499b.png)

**同一段对话，保存为六种详细程度。**

DeepSeek Harness 插件默认每 **6 轮**完整对话封存一个 Block，一轮指一次用户提问和助手的完整回复。封块大小可以配置；核心库默认值为 12 轮。尚未达到边界的内容继续保留在当前对话中。

每个完成处理的 Block 包含以下视图：

| 层级 | 保存的内容 | 主要用途 |
| --- | --- | --- |
| L0 | 标题和标签 | 用最少内容标识这段历史 |
| L1 | 简短摘要 | 快速了解讨论主题 |
| L2 | 关键事实 | 查看决定、约束、计划和结果 |
| L3 | 确定性精简对话 | 删除固定白名单中的独立寒暄或确认；重复的长段落与代码只保留第一次；工具调用保留名称和结果摘要 |
| L4 | 去除内部记录的近原文对话 | 过滤 system 消息；用户和助手正文只裁剪首尾空白并添加角色标签；可识别的工具记录保留名称和结果摘要 |
| L5 | 原始消息与工具记录 | 查证来源及具体细节 |

L0–L2 由模型概括；L3/L4 由固定规则生成：L3 删除独立寒暄和重复长文本，L4 则尽量保留原话；两者都会精简可识别的工具记录。具体规则见下方。短期衰减按后续就绪 Block 的数量推进，不按现实中经过的天数计算。

<details>
<summary>具体精简规则、衰减公式与层级阈值</summary>

L0–L2 由模型概括生成；L3、L4 不调用模型改写，而是由程序按以下固定规则生成：

- **L4：** 删除 system 消息；用户和助手正文只裁剪首尾空白并添加 `User`、`Assistant` 等角色标签。对于能够识别的结构化工具记录，只保留工具名称和最长 160 字符的结果摘要，省略原始 `arguments`、`params`、`input` 和 `request`；无法识别为工具 JSON 的 tool 正文保持原样。
- **L3：** 在不改写语义的前提下进一步精简。只有当整句去掉末尾标点后命中固定白名单时，才删除 `ok`、`thanks`、`好的`、`明白`、`收到`、`谢谢`、`可以` 等独立寒暄或确认。程序把连续空白合并并忽略大小写后，对代码型段落或至少 80 字符的长段落去重：第一次保留原文，之后的完全重复内容替换为省略标记。工具记录采用与 L4 相同的名称和结果摘要形式。
- **长度保护：** 如果生成的 L4 比 L5 更长，就直接使用 L5；如果 L3 比 L4 更长，就直接使用 L4，确保 `L3 ≤ L4 ≤ L5`。

原始记录先保存，摘要和事件处理随后进行。只有处理完成、进入就绪状态的 Block，才会替换对应的原生历史并参与衰减。

**后续对话越多，旧 Block 默认展示得越简略。**

Block 的展示变化由指数衰减控制：

<p align="center"><strong>w<sub>block</sub>(age) = e<sup>−λ<sub>block</sub> · age</sup></strong></p>

其中，衰减系数 λ<sub>block</sub> 默认取 **0.30**，程序根据权重区间选择当前展示层级。系数越小，详细内容保留得越久，相应占用的上下文也越多。

公式中的 `age` 按当前展示锚点与同一会话最新就绪 Block 之间的距离计算。它衡量的是对话积累的进度，**不是现实中经过的天数**。尚未封存的对话，以及仍在等待模型处理的 Block，都不会推动这项衰减。

例如，一个从 L5 开始、期间没有重新展开的 Block，在默认参数下会经历：

| 后续新增的就绪 Block 数量 | 默认展示层 |
| ---: | --- |
| 0–1 | L5 |
| 2 | L4 |
| 3–4 | L3 |
| 5–6 | L2 |
| 7–8 | L1 |
| 9 及以上 | L0 |

图中的层级变化用于展示趋势，实际变化由衰减参数和层级阈值共同决定，并非每新增一个 Block 就下降一级。

</details>

**需要细节时，可以重新展开。**

假设某段旧对话目前只显示：

> 讨论了项目技术方案与近期计划。

用户追问“当初为什么选择 pnpm”，Agent 可以展开关键事实、精简对话或完整原始记录，找到当时的原因。

展开既可以逐级进行，也可以直接指定更详细的层级。展开后，系统会以此次选定的层级和当前 Block 位置重新设置衰减起点；随着后续对话继续积累，它再逐渐变简。

因此，旧对话日常可以保持轻量，需要时仍能恢复细节。**L0–L4 都是原始记录的派生视图，不会覆盖 L5。**

<a id="event-cards"></a>

### 2. 长期记忆：事件线保留历史，知识图谱整理当前状态

短期记忆保留一段讨论的上下文，长期记忆则把值得在后续会话中继续使用的信息提取出来。StrataGate 用 Event 记录决定、偏好、计划和变化，再根据这些事件整理知识图谱。

![图 3：StrataGate 长期记忆更新——事件提取、历史关系与当前状态图谱](docs/assets/fc07e5b6e1cc07c115faa773a2718aa9.png)

**事件卡记录发生过什么，并保留来源。**

同一个 Block 可以产生多条 Event，也可以没有需要提取的长期信息。每条事件除了内容，还保存来源 Block、来源消息，以及可确定的时间信息。

时间信息需要区分两个含义：

| 时间 | 表示什么 |
| --- | --- |
| 提及时间 | 这件事什么时候在对话中被说到 |
| 发生时间 | 事情实际发生或计划发生的时间 |

例如，用户在 5 月 6 日说“下周完成原型”，5 月 6 日是提及时间，“下周”描述的是计划完成时间。这条记录应保留计划性质，不能直接作为“原型已经完成”的证据。

当时间无法确定时，保留原始表达和不确定性，方便之后回到来源核对。

**新事件通过补充、取代或冲突关系更新记忆。**

项目讨论可能先后出现：

> “这个项目使用 npm。”
>
> “我们改用 pnpm。”
>
> “下周完成原型。”

这三条信息的作用不同：

- “改用 pnpm”更新了包管理器选择，旧 npm 事件保留为历史。
- “下周完成原型”补充了一项计划，不影响包管理器选择。
- 如果出现无法同时成立、又不能确定哪条有效的说法，则保留冲突关系，供后续核实。

旧事件的内容和来源不会被新事件覆盖，其有效状态和关联关系可以随新证据更新。因此，系统既能找到当前有效的信息，也能回答“以前是什么样、后来发生了什么变化”。

<a id="current-state-graph"></a>

**知识图谱根据事件整理当前信息和关系。**

图谱将人物、项目、组织、工具和地点表示为节点，将“使用”“参与”“依赖”等联系表示为有方向的关系。节点属性和关系都保留来源 Event。

在上述例子中，图谱可以把项目当前使用的包管理器更新为 pnpm，同时保留 npm 的历史状态。之后：

- 问“项目现在使用什么”，可以先查当前图谱；
- 问“什么时候改的”，可以查变更事件；
- 问“为什么改”，可以进一步展开事件并回查原始讨论。

图谱中的状态需要与来源一致。“下周完成原型”直接支持的是一项计划；图中展示的“原型开发中”或“负责人”等信息，需要相应事件提供额外依据。

图谱更新作为独立任务执行并保存进度。更新失败时，可以单独重试，已经写入的事件和原始来源仍然保留。

<a id="evidence-gate"></a>

### 3. 证据门：检查检索结果是否足以回答当前问题

找到相关记忆之后，还需要判断它能否支持当前答案。StrataGate 通过一个固定、简短的评估结构，要求 Agent 明确说明证据是否充分，以及接下来应当做什么。

| 评估项 | 需要说明的内容 |
| --- | --- |
| `verdict` | 证据充分、部分充分，还是与问题不符 |
| `evidence_refs` | 哪些检索结果支持当前判断 |
| `fit` | 证据与问题具体匹配在哪里 |
| `missing` | 还缺少哪些信息 |
| `next_strategy` | 直接回答，还是继续搜索或展开 |

例如，用户问：

> 为什么当初改用了 pnpm？

检索结果只有：

> 项目已从 npm 改为 pnpm。

这条结果确认了变更，却没有说明原因。Agent 应将其判断为部分充分，继续展开事件或回查原始对话，而不能仅凭工具选择推测当时的理由。

证据门由模型判断内容是否充分，程序负责检查引用和流程约束：被引用的证据必须来自指定检索批次；接受 `sufficient` 时，需要有效证据引用，并明确选择回答。

这些检查使检索过程可以追踪和核验，但模型仍可能误判证据。没有找到足够信息时，应继续查找，或在回答中明确说明无法确认。

<a id="use-only-reinforcement"></a>

### 4. 只强化实际使用的记忆：采用越多，之后衰减越慢

长期记忆也会随对话推进而衰减。这里变化的是 Event 的权重，它参与后续召回和排序；与短期 Block 不同，Event 不会因此逐级切换 L0–L5 展示层。

![图 4：StrataGate 长期记忆权重——自然衰减、仅检索不强化与采用后强化](docs/assets/cecc9d191a4b9bf22a479623e2ebdc1d.png)

未被用于答案的 Event 权重随对话轮次逐渐降低，可能影响后续召回的排序，但历史记录仍然保留。

**被搜索到，不会触发强化。**

检索命中只说明一条记忆可能相关。系统可以记录它何时被检索，但不会因此增加采用计数，也不会重置衰减起点。

自动带入上下文的记忆同样不会因为被展示而获得强化。这样可以避免某条记忆仅因偶然排在前面，就通过反复出现不断提高自身权重。

**记录为实际采用后，才更新权重。**

Agent 确定用于最终回答的证据后，会提交采用回执。通过检查的 Event 增加采用计数，并把衰减起点更新到当前轮次。对于未被额外限制权重的普通活跃事件，此时权重回到 1。

随着采用计数增加，公式中的衰减系数变小，同样经过一段对话后，它能保留更高的权重。因此，反复帮助回答的记忆会逐渐衰减得更慢。

采用依据来自 Agent 提交的证据选择。程序检查证据是否属于对应批次、是否经过充分性评估，并通过回执避免同一次操作被重复执行；没有使用的检索结果不获得这次强化。

**不同重要程度的记忆，可以保留不同的最低权重。**

| 记忆类别 | 默认最低权重 |
| --- | ---: |
| 普通信息 | 0 |
| 用户偏好 | 0.3 |
| 身份信息 | 0.9 |
| 安全信息 | 1.0 |

此外，置顶记忆的有效权重保持为 1；被取代的事件通常设置较低的权重上限，避免旧状态持续占据较高优先级。

这些权重表达的是记忆管理策略，不能当作事实正确率。权重较高的信息仍需要结合当前问题、最新状态和原始来源进行判断。

<details>
<summary>长期权重公式与计数含义</summary>

**新事件具有初始权重，未被采用时逐渐衰减。**

长期 Event 的基础权重函数为：

<p align="center"><strong>w(t,n) = max(floor, e<sup>−λ(n)t</sup>)</strong></p>

<p align="center"><strong>λ(n) = 0.15 / (1 + 1.5 ln(n))</strong></p>

其中：

- `t` 是当前轮次与上次采用轮次的差，新事件从创建时开始计算；
- `n` 是内部采用计数，初始化为 1，每次记录采用后增加 1；
- `floor` 是根据记忆重要程度设置的最低权重。

长期权重衰减同样按对话轮次计算，而不是按现实时间计算。较低的权重可能降低一条记忆在后续召回中的优先级，但不会因衰减而删除它的历史记录。

</details>

<a id="external-memory-import"></a>

## 外部 AI 记忆迁移

可以导入其他 AI 导出的记忆总结。StrataGate 将重要信息整理为 Event，与已有记忆比较，并保留原始导入内容供追溯。

DSH 管理界面提供导入预览：重复内容可以忽略，变化可以新增、合并或取代旧状态，不确定的关系可以标为冲突。低置信度项可人工选择处理方式，提交后可按批次撤销。旧事件及其来源仍会保留。

导出格式、提示词与接入示例见[外部记忆导入说明](docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md)。

## 一次真实的检索

LoCoMo 中有一道题询问 Caroline 在什么时候进行了学校演讲。检索过程是：

1. 搜索事件，找到“学校演讲”事件卡，但没有具体日期。
2. Agent 判断证据部分充分，指出缺少发生日期，继续检索原始消息。
3. 找到 2023-06-09 的消息，其中写着“last week”。
4. 结合消息时间理解“上周”，得到足够的时间依据后回答。

事件卡帮助定位，原始消息和时间戳帮助核对；证据门要求 Agent 识别缺口，继续查证。

<a id="实验结果"></a>
<a id="experimental-results"></a>

## 评测结果与边界

仓库公开的 R8 对比评测使用 LoCoMo 中的 `conv-26` 对话样本，包含 **419 条消息、35 个会话和 152 道问题**，覆盖 category 1–4。

两个系统分别生成答案，再对每道题的答案进行 **10 次独立 Judge 评审**。这里的十次指评审重复次数，不代表十次完整系统运行。

| 指标 | StrataGate | Mem0 base | 差值 |
| --- | ---: | ---: | ---: |
| 10 次评审平均准确率 | **80.46%** | 63.22% | **+17.24 个百分点** |
| 多数票正确 | **121 / 152（79.61%）** | 96 / 152（63.16%） | **+25 题** |
| 时间类问题（Temporal） | **74.86%** | 34.59% | **+40.27 个百分点** |
| 单跳问题（Single-hop） | **89.29%** | 75.14% | **+14.14 个百分点** |
| 多跳问题（Multi-hop） | **66.56%** | 61.56% | +5.00 个百分点 |
| 开放域问题（Open-domain） | 83.08% | **84.62%** | -1.54 个百分点 |

两边使用相同的问题、顺序、答案模型、Judge 模型、评审提示词、解析器和评审次数，并分别重新构建记忆。记忆抽取、检索实现、embedding 使用方式和回答上下文存在差异，因此这里比较的是两套完整系统配置。

这组结果仅覆盖 `conv-26`，不代表完整 LoCoMo 成绩，也不能单独证明短期记忆衰减、知识图谱或证据门中某一项机制带来的收益。各组件的独立作用仍需通过消融实验检验。

完整协议、逐题结果及评审波动见 [评测文档](docs/EVALUATION.md)，汇总数据见 [机器可读评测结果](benchmarks/locomo-conv26-r8-final.json)。

上述 R8 评测中，仍有 **31 道题被多数评审判为错误**。按可观察到的失败阶段划分：

| 失败阶段 | 题数 | 反映的问题 |
| --- | ---: | --- |
| 未发起检索，直接回答错误 | 15 | Agent 有时未意识到需要查找历史证据 |
| 证据被判为充分，最终答案仍然错误 | 14 | 证据可能属于相邻事件，或不足以支持完整答案 |
| 达到检索预算时，证据仍不充分 | 2 | 在给定预算内没有找到足够的信息 |

这些结果说明，在该评测范围内，仍需改进何时发起检索，以及如何判断证据是否真正回答了问题。证据门能够约束引用和评估流程，但不能保证模型的语义判断或最终答案一定正确。

R1–R8 的设计演变、逐题分析与后续验证方向见[完整评测](docs/EVALUATION.md)。

## 使用范围与成本

记忆可以按项目、会话或全局范围组织。知识图谱界面用于查看信息、关系与来源；多人协作编辑和跨产品云端同步不是主要功能。

分层视图减少的是回答时带入的历史上下文。后台生成摘要、提取 Event 和整理图谱仍会调用模型，因此不能把上下文减少直接等同于总 Token 或费用下降；工具记录较多时，后台成本尤其需要结合实际使用量评估。

公共 API、模型接入和评测覆盖仍在迭代，自定义集成应固定版本并验证自己的场景。证据门要求模型说明依据，但不能保证判断和答案永远正确。

<a id="代码入口"></a>
<a id="code-entry-points"></a>

## 开发与文档

本节面向开发者。直接使用 DeepSeek Harness 插件的用户，可以按照 [快速开始](#quick-start-deepseek-harness)安装，无需自行构建仓库。

开发环境需要：

- Node.js **22.19.0 及以上的 22.x 版本**，或 **24.0.0 及以上版本**；
- 对应的版本声明为 `^22.19.0 || >=24.0.0`。

检出仓库后，在仓库根目录运行：

```bash
npm install
npm run check
npm test
npm run build
```

| 资源 | 内容 |
| --- | --- |
| [DeepSeek Harness 使用说明](docs/DSH.zh-CN.md) | 安装、配置、界面、记忆工具和恢复机制 |
| [架构文档](docs/ARCHITECTURE.md) | 分层规则、事件与图谱、检索、证据门、权重和存储约束 |
| [外部记忆导入](docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md) | 导出格式、导入流程和接入示例 |
| [完整评测](docs/EVALUATION.md) | 实验协议、版本演变、失败分析和结果范围 |
| [评测汇总数据](benchmarks/locomo-conv26-r8-final.json) | 已公开运行的结果、统计和产物信息 |
| [核心引擎示例](packages/core/examples/basic.ts) | 最小 API 接入示例 |

核心实现位于 `packages/core/`，DSH 适配层位于 `src/`。分层规则见 [blocks.ts](packages/core/src/blocks.ts)，长期权重见 [weights.ts](packages/core/src/weights.ts)。

核心库的 `StrataGate.open()` 使用 SQLite，`StrataGate.inMemory()` 用于临时运行和测试。持久化模式下，`recordMemoryUse()` 必须提供稳定的 `receiptId`；同一次采用操作重试时复用该 ID，避免重复强化。参见[架构说明](docs/ARCHITECTURE.md)。

## 参与贡献

欢迎各种形式的贡献：修复问题、完善文档、增加集成，或探索更好的记忆与检索方案都可以。

请先阅读 [`CONTRIBUTING.zh-CN.md`](CONTRIBUTING.zh-CN.md)，其中包含 monorepo 开发环境、检查与测试命令、适合参与的方向，以及提交 Pull Request 的建议。如果还不确定一个想法是否适合项目，建议先[创建 Issue](https://github.com/diqierjia/StrataGate-AgentMemory/issues)，再投入较大的改动。

## 贡献者

<a href="https://github.com/diqierjia/StrataGate-AgentMemory/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=diqierjia/StrataGate-AgentMemory" alt="StrataGate 贡献者" />
</a>

## 许可证

StrataGate 使用 [MIT License](LICENSE)。
