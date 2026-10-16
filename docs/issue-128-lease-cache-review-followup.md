# Issue #128：同 revision 续租缓存复审修复

源码提交：`0f0cb8fbce5a116e4670785716aa62f68cdd9c08`。本报告之后的交付提交只增加证据文档；交付 SHA 以离线包 manifest 为准。

上轮交付：`bc73b6b7b2353e9c82726b8976f440672546ce9e`。完整修复基线：`e954eaf2f2cbbef4bb6226a2ebb35191424868c2`。

## 复现与修复

审查指出的边界成立。B 在 A 续租前加载 running Job，A 用真实独立 OS 子进程调用 SQLite 续租接口，业务 revision 不变；推进时钟越过 B 缓存的租约时间，B 尝试处理另一线程的 Block。修复前，Summary、Extraction、Graph、Topic 四个定向用例均出现 `Storage lease conflict`，无法完成另一任务。干净复现日志为 `lease-cache-repro-fixed-fixture.log`，不是仅凭静态推断。

最小修复继续把 Jobs 作为事实来源，不增加业务 revision、不引入新的业务状态机或常驻历史缓存：

- SQLite 增加可选的轻量 `loadDerivationLeases()`。一次读事务获取当前 namespace 的 revision 和四类 running 认领元数据，不读取消息、Block 正文、Event 内容或 Graph 节点。Graph/Topic 只向调用者返回 Job 身份、attempt、updatedAt、leaseUntil；Topic 的 JSON 查询在 SQLite 内完成。
- 本地发现 running 租约已到期时，恢复前先同步持久化元数据。`reloadFromStorage()` 与 `refreshFromStorage()` 在 revision 相同且认领身份一致时，只同步租约字段。业务 revision 变化，或 running 集合、attempt、updatedAt 不一致时，才读取完整权威快照；不能用租约读结果猜测业务状态。
- Topic claim 使用同一个到期前置同步。正常完成、到期恢复、失败重试和最大次数仍由原有状态机处理，写入仍受 SQLite 事务认领与租约校验保护。
- 心跳仍可能恰好发生在元数据读取之后、恢复写入之前。SQLite 会拒绝旧租约写入；前台 Block 调度遇到冲突后刷新持久化状态，并至少等待原有 3 秒 Worker 间隔后再试，不为这次正常竞争记录插件错误。其他抛出的异常也受同一个重排下限约束。新任务正常唤醒和既有持久化失败重试时间不变。

没有调大后台轮询间隔。新元数据读取用于实际任务恢复及显式重载，空闲轮询仍只查到期调度/脏键索引、额度和独立 Profile Maintenance，不会因此逐个打开 namespace。旧数据库可按原有迁移与分批脏键重建发现旧任务；跨进程写入仍依赖持久化触发器和轻量轮询，不依赖内存通知。

## 定向验证

- 四类真实子进程续租：B 未显式 reload，也不会误恢复 A；A 保持 running、attempt 不变；另一线程任务完成；重复三轮不重复调用模型；续租同步期间完整 `SqliteStorage.load()` 调用为零。观察者的两种显式重载接口也取得同 revision 新租约。
- 同 revision 下认领 attempt 或状态被外部 SQL 改变：确实加载一次完整权威快照，而不是只替换租约。
- 前台真实 SQLite 竞争：读取旧元数据后 A 再续租，B 越过旧截止时间，事务拒绝恢复写入。没有插件错误日志；2,999ms 内不重试，3,000ms 后另一任务完成；额外推进 10 秒不再重排；完整加载仍为零。
- 既有失败恢复测试改用模拟定时器，明确断言退避期间 namespace 仍可打开、退避后任务完成，没有增加测试超时。
- 全范围自查还复现了最终一次 Summary/Extraction 租约中断后的终止边界：Core 已拒绝再执行，恢复留下的到期时间仍会让前台不断重排一个无法执行的任务。两个修复前回归均发现立即重试定时器；前台增加原有最大尝试次数过滤后，连续四次调度都不再创建定时器，模型调用为零。没有修改持久化重试 ledger 或增加尝试次数。

时间边界使用注入时钟/模拟定时器；续租写入和认领竞争使用真实 SQLite，四类续租各使用真实独立 OS 进程。没有声称在本轮实际等待 5 分钟网络模型调用。

## 整体核查与测试

Windows x64 / Node `24.19.0` / `CI=true`：

- `npm run check` 通过。
- `npm test`：Core **312**、DSH **591**、WorkBuddy **10**，共 **913** 项通过、**1** 项既有跳过。
- Issue #128 两个定向文件共 **41** 项通过（Core 30、DSH 11），包含先前 FTS、坏键公平重建、open tail、租约续期及本轮缓存和最终尝试边界回归。
- `npm run build` 全部目标通过；`node scripts/verify-package.mjs` 验证 58 个包内文件及干净 tarball 安装，通过。
- Windows DSH `0.2.0-rc.1` 和 `0.2.0-rc.2` 各自完整兼容脚本通过，均在冻结源码下完成类型检查、591 项 DSH 测试（1 项既有跳过）、构建、干净包安装、真实 CLI 启动、陈旧 peer 可恢复修复、管理能力、两条会话标题/页面和旧迁移，退出码均为 0。
- 首次 rc.1 流程跨过了最终尝试次数补丁，未作为最终提交的完整证据。冻结后完整补跑日志为 `lease-cache-compat-rc1-final.log`；rc.2 日志为 `lease-cache-compat-rc2.log`。补跑 rc.1 和最后构建/包检查只关闭 npm 附带的 audit/fund 网络请求，依赖安装和全部功能断言保留；未执行安全漏洞审计。环境记录见 `lease-cache-validation-context.json`。

自查覆盖整个调度与 FTS 范围：派生索引与任务保存仍在同一事务；坏键持久化 60 秒退避与 generation 校验保留；未变化消息 UPSERT/FTS UPDATE 触发器仍不污染 dirty 集合；普通打开不再全库检查 FTS，旧库按搜索 namespace 懒回填，显式修复入口保留；只有可封存 open tail 的资格检查与 Worker 一致；Topic Event 版本动态工作及历史额度、模型就绪、重启恢复和独立 Profile Maintenance 相关回归仍通过。

本轮初次全量运行有一项失败：旧测试默认等待窗口短于新增 3 秒异常退避。修正为上述明确的时间边界断言后完整复验通过。离线包保留干净的修复前四类失败日志与最终通过日志，避免混用。

## 性能与验收边界

本轮没有重新采集 CPU/RSS 基准。此前 [Windows 合成数据](benchmarks/issue-128-windows-review.json) 属于源码 `415096f19d09d9bcc29c44634c7ae78fd6c2f52d`，其中 1449.42 MiB 合成库的 Worker CPU 61.80% → 1.20%、三轮完整加载 300 → 0，不能标注为本轮源码的测量。本轮的空闲回归继续验证 100 namespace 多轮、1000 namespace 大规模扫描不打开完整记忆；这不是完整 DSH 桌面进程 CPU 验收。

原用户 168 MB / 14 namespace 数据库、真实网络长模型、桌面界面响应及长期 CPU/RSS 仍需人工验证；远端 CI 未知。没有访问或修改用户生产数据库，没有推送 GitHub、更新 PR、合并或发布版本。

## 离线交付

新包包含完整提交源码 ZIP、完整任务分支历史 Git bundle、相对基线完整补丁、相对上轮增量补丁、测试/兼容日志、报告、中文审查提示词和 SHA-256 manifest。bundle 包含基线及其祖先，无外部 prerequisite；会在本任务的新隔离目录实际克隆并检查 HEAD。它仅包含任务分支引用，不打包其他工作分支。

完整源码包含 lockfile、测试夹具和构建配置。Node/npm 依赖未内嵌，重新执行测试需要可用 npm registry 或预先准备的依赖缓存；Git 仓库恢复本身不依赖 GitHub。历史报告与性能 JSON 保留原来的源码归属，最新结论以本报告和 manifest 为准。
