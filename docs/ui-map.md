# StrataGate 前端界面地图、视觉基准与验证指南

本指南用于帮助 Agent 快速定位界面模块、掌握全局视觉调色盘，并通过**多方案对比选优**与**真实记忆库影子副本截图自检**消除“缝合感”和改东坏西的问题。

---

## 一、 页面与模块地图（`src/client/`）

前端源码按职责拆分为 `src/client/` 下的 8 个模块。修改界面时直接编辑对应模块文件，运行 `npm run check:client` 或 `npm run build:dsh` 会自动同步生成 `src/client.js` 并执行静态校验。

| 模块文件 | 对应界面位置（用户视角） | 核心组件 / 函数 | 关键 DOM 选择器 | 关联后端路由（`src/web.ts`） |
| :--- | :--- | :--- | :--- | :--- |
| `src/client/01-navigation-and-styles.js` | 全局样式表、设计变量、深链跳转（反馈草稿 / 图谱节点跳转） | `FeedbackSettingsPage`, `navigateToFeedback`, `navigateToGraphNode`, `css`, `R6_STYLES` | `.sg-memory`, `.sg-tabs`, `.sg-pg-head` | - |
| `src/client/02-chat-citations-and-feed.js` | 聊天流底部“记忆引用”折叠条、本轮会话记忆层状态 | `MemoryCitationTail`, `RetrievalProcessPanel`, `ShortTermMemoryTurnStatus`, `api` | `.sg-citation-tail`, `.sg-stm-turn` | `/api/stratagate/short-term` |
| `src/client/03-graph-and-event-widgets.js` | 知识图谱画布、节点详情、事件卡片与权重衰减轨迹图、通用空状态/搜索框 | `GraphCanvas`, `NodeDetailPanel`, `EventDetailPanel`, `MemoryWeightTrajectory`, `TimelineList` | `.sg-graph-canvas`, `.sg-event-card`, `.sg-weight-chart` | `/api/stratagate/dashboard`, `/api/stratagate/event` |
| `src/client/04-topics-dreaming-long-term.js` | **长期记忆**页（章节话题目录、时间线、知识图谱切换）、**Dreaming 整理记忆面板与每日来信弹窗** | `LongTermPage`, `TopicDirectory`, `TopicChapter`, `DreamingPanel`, `DreamingLetterModal` | `.sg-topic-directory`, `.sg-dreaming`, `.sg-daily-letter` | `/api/stratagate/topics/*`, `/api/stratagate/dreaming/*`, `/api/stratagate/letters/*` |
| `src/client/05-short-term-and-daily-notes.js` | **短期记忆**页（每日工作笔记）、**会话记忆**页（封存块 L0–L5 展开）、后台处理状态页 | `DailyNotesPage`, `ShortTermPage`, `BlockLayerPanel`, `LayerPreview`, `ProcessingStatus` | `.sg-daily`, `.sg-days`, `.sg-day-d`, `.sg-daily-note` | `/api/stratagate/daily`, `/api/stratagate/daily/note`, `/api/stratagate/block/*` |
| `src/client/06-import-more-and-support.js` | **更多**页主页、外部记忆导入、显示开关、问题反馈草稿与诊断报告、重复事件治理、系统/审计/原始数据 | `MoreHome`, `ImportPage`, `DisplayPage`, `SupportPage`, `DuplicateReviewPage`, `SystemPage` | `.sg-more-home`, `.sg-support`, `.sg-dup-pair` | `/api/stratagate/import/*`, `/api/stratagate/feedback/*`, `/api/stratagate/duplicates/*` |
| `src/client/07-profile-and-settings.js` | **常驻画像**页、高级设置页（后台记忆模型、向量/重排检索设置、图谱开关、每日笔记设置） | `ProfilePage`, `SettingsPage`, `MemoryModelSettings`, `RetrievalModelSettings`, `GraphControlPanel` | `.sg-profile-row`, `.sg-retrieval-settings`, `.sg-graph-menu` | `/api/stratagate/profile/*`, `/api/stratagate/settings/*`, `/api/stratagate/retrieval-settings/*` |
| `src/client/08-overview-shell-and-entry.js` | **总览**页（五层记忆数量漏斗、近 4 周回答采用热力图、整理记忆与来信入口）、顶部导航栏与插件入口 | `OverviewPage`, `MemoryPage`, `SidebarPlacementPrompt`, `apply` | `.sg-overview`, `.sg-tabs`, `.sg-sidebar-placement-prompt` | `/api/stratagate/dashboard` |

---

## 二、 视觉基准调色盘（给全局视野，不绑死设计上限）

为了避免局部修改时因看不见全局风格而写出“东拼西凑的缝合怪”，同时不限制更强模型在遇到新场景时设计更优雅的交互，界面遵循**“共用底色与排版基因，放开组件形态创新”**的原则：

1. **颜色与表面变量（自动跟随 DSH 浅色/深色主题）**
   - 页面与卡片底色：`var(--sg-page)`（主背景）、`var(--sg-surface)`（卡片/输入表面）、`var(--sg-soft)`（次级柔和底色 / 悬停态）、`var(--sg-sheet)`（纸张感面板底色）。
   - 文本层级：`var(--sg-text)`（主文字）、`var(--sg-muted)`（次级说明文字）。
   - 边框与分割线：`var(--sg-border)`（常规边框）、`var(--sg-hair)`（极细分割线）。
   - 语义与层级点缀色：
     - 品牌/主操作：`var(--sg-accent)`、`var(--sg-accent-soft)`
     - 五层记忆家族色：`var(--sg-ink)`（常驻画像）、`var(--sg-moss)`（记忆目录）、`var(--sg-water)`（会话记忆）、`var(--sg-sand)`（短期记忆/每日笔记）
     - 状态反馈：`var(--sg-good)` / `var(--sg-good-soft)`（正常/完成）、`var(--sg-warn)` / `var(--sg-warn-soft)`（提醒）、`var(--sg-danger)` / `var(--sg-danger-soft)`（错误/危险操作）
2. **字体与页头规范**
   - 字体变量：`var(--sg-sans)`（正文无衬线）、`var(--sg-serif)`（章节/日期/来信标题衬线体）、`var(--sg-mono)`（数字统计/代码等宽字体，搭配 `font-variant-numeric: tabular-nums`）。
   - 一级子页面统一使用 `.sg-pg-head` 页头结构（包含 `h2` 标题、`.sg-pg-tag` 状态说明与 `.sg-pg-end` 右侧轻量控件），保持各标签页切换时的呼吸感与对齐一致。
3. **客观硬底线（由代码强制拦截）**
   - `scripts/check-client.mjs` 会自动拦截**未定义的 `--sg-*` / `--sgm-*` 变量拼写错误**、**JS 语法错误**、**未声明变量/函数名拼写错误**、**重复定义**和**常量误改**。
   - 严禁产生横向滚动溢出（`panel.scrollWidth > panel.clientWidth`）；弹性或网格子元素需包含 `min-width: 0` 与长文本折行（`overflow-wrap: anywhere`）。

---

## 三、 前端开发与测试流程：多方案对比 + 真实记忆库影子自检

### 1. 界面新增或改版：先出 A / B / C 多方案对比，选优后再写正式代码
审美没有唯一公式，单出一个方案容易流于平庸或缝合：
- **并排对比**：遇到新功能或排版重构时，先在 `.lavish/` 画板中用真实长短数据样本并排生成 **2～3 个不同排版方案（A / B / C）**（可附带旧版对照）。
- **内部赛马或用户挑选**：Agent 可先截图自检淘汰掉不协调的方案，或通过 `lavish-axi` 打开对比页让用户直观挑选、组合优点（如“要 B 的布局 + A 的标签”），循环微调定稿后，再一次性写入 `src/client/` 正式模块。

### 2. 代码修改后：跑静态查错与真实记忆库影子副本端到端测试
不要只用空数据库做假测试。本地测试直接利用电脑上 DeepSeek Harness 现有的真实记忆库（`~/.dsh/stratagate/memory.db`）生成 **1 秒临时影子副本**：

```bash
# 1. 同步 src/client/*.js 并执行前端静态查错 + TypeScript 检查
npm run check:dsh

# 2. 用真实记忆库影子副本跑全页面端到端测试并生成宽/窄屏、深/浅色真实截图
npm run test:e2e-real-memory

# 3. 启动真实 DeepSeek Harness（@deepseek-ai/dsh），在聊天框发消息驱动 Agent 调记忆工具并核验聊天引用与面板更新
npm run test:e2e-dsh-agent

# 4. 运行默认浏览器回归套件（含真实记忆库面板 E2E + 真实 DSH 聊天 Agent 全链路 E2E + Dreaming 交互测试）
npm run test:browser
```

- **安全保障**：`scripts/test-real-memory-e2e-browser.mjs` 与 `scripts/test-dsh-agent-e2e-browser.mjs` 只在系统临时目录（`tmpdir()`）操作记忆库和每日笔记的复印件，并在测试前后比对原库 `memory.db` 的 SHA-256 哈希与修改时间，确保原库分毫不改。
- **真实 DeepSeek Harness + Agent 闭环（`npm run test:e2e-dsh-agent`）**：真正拉起 `@deepseek-ai/dsh` Web 宿主并挂载插件与真实记忆库影子副本，在聊天界面切换到真实工作区（如 `DH`）、在输入框输入并发送消息，驱动 Agent 走完“系统提示词注入真实记忆 → `memory_search_events` → `memory_assess` → `memory_record_use` → `memory_daily_write` → 聊天回复底部弹出记忆引用条与检索过程 → 点开记忆引用详情卡片 → 进入设置页 StrataGate 面板核验新写入的每日工作笔记”完整链路，截图保存在 `.artifacts/dsh-agent-e2e/`。
- **睁眼看图交证据**：测试运行后会在 `.artifacts/real-memory-e2e/` 与 `.artifacts/dsh-agent-e2e/` 生成真实数据渲染截图与 `report.json`。Agent 修改界面或 Agent 记忆逻辑后必须调用 `view_image` 亲自查看渲染截图，确认长文本不拥挤、Agent 调工具与界面联动正常后再交付。
