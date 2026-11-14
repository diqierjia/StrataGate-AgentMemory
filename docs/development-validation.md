# 开发和发布时如何避免重复检查

目标是在代码稳定后运行一次与风险相称的完整 CI，后续步骤复用可信结果；候选包和正式包各自只补做针对实际包的检查。

1. 修复过程中先运行受影响的测试。合并同一轮反馈后再推送，避免每处小修改都启动完整 CI。新的 PR 提交会取消同一 PR 尚未完成的旧 CI；不同 PR 和 main 的运行互不影响。
2. 准备发布的功能 PR 直接把目标正式版本号写入 `package.json` 和 `package-lock.json`，并用这个文件树跑最终 PR CI。合并后 main CI 复用同一文件树的证据，发布工作流直接从合并提交生成正式包，不再创建单独的改版本号 PR。普通修复如果不发布，不需要提前改版本。
3. 记录已通过 CI 的提交、文件树和检查范围。同一文件树且检查范围满足要求时，审查后直接复用，不再人为触发空提交或重复完整 CI。文件、依赖、构建配置或测试范围变化时，重新执行受影响的检查；不能把不同版本的包当作相同文件。
4. 候选包用于人工验收，不上传 npm。候选版本只在提交源码的暂存副本中改成 `T-candidate.N`，使用 `node scripts/stage-candidate.mjs --version T-candidate.N --output <暂存目录>` 生成；正式源码和 lockfile 始终保留 `T`。候选只检查包内容、安装和启动，不重复源码测试；历史宿主全矩阵按风险或定期执行。
5. 正式发布从进入 main 的源码经 GitHub Actions trusted publishing 生成，核对实际正式包、安装、来源和公开结果。发布 workflow 核实同树的 PR 完整 CI，或同一 main 提交的完整 CI；找不到、仍在运行、任务缺失或查询失败时停止发布。正式包只打一次，内容检查和安装验证使用同一个文件。

PR CI 明确测试 PR 头提交。合并到 main 后，仅当已合并的同仓库 PR 头提交与 main 的完整文件树一致，且指定工作流的全部必需任务均已成功时，main 才跳过重复测试；其他情况自动运行完整 CI。发布时重新核验这些证据。候选和正式包版本不同，必须检查实际发布的包。

## 下一步的优先顺序

1. 对照 Windows 三个代表任务的总时长，确认复用隔离 CLI 之后比 [run 42344461565](https://github.com/diqierjia/StrataGate-AgentMemory/actions/runs/42344461565) 的大约 15 / 23 / 36 分钟更短。第一次运行要安装并写入缓存；同一缓存键的下一次运行才是命中。不要为了缩短时间删掉代表版本或 Windows。
2. 将发布所需版本尽量包含在最终功能 PR，并在定稿后跑最终 CI；修复迭代用相关测试和审查，避免为每次评审都等完整矩阵。合并产生的文件树如与已测树不同，补测合并结果。
3. 对候选包复用同一源码的 CI：候选版本号在独立暂存目录设置，记录被测源码提交与版本元数据差异；打包后对该文件执行 `node scripts/verify-package.mjs <候选包路径>` 和针对当前宿主的 `node scripts/verify-dsh-install.mjs <候选包路径>`，不重复运行源码测试。两条命令应在候选源码的构建环境运行，并设置 `DSH_VERSION` 为当前宿主版本。
4. 对正式发布、直接推送和合并结果变化，使用工作流中的证据核验；不得仅按提交消息或文件名判断已通过。

候选暂存脚本只读取指定提交并在临时副本中改写版本，源码工作树不会被候选后缀污染。发布工作流会拒绝候选版本源码，确保正式包只能从正式版本文件树生成。

## Windows 兼容验证按风险分层

PR CI 先看这次改了哪些文件，再决定要不要跑 Windows。依据是这些文件会不会进入 DSH 兼容套件（`check:dsh`、`test:dsh`、`build:dsh`、`verify:dsh`），不看提交说明。

需要 Windows：

- `src/` 下的插件源码，以及 `packages/core/src/`、核心包的 `package.json` 和 tsconfig
- 根目录 `tests/**/*.ts` 和 `tests/fixtures/`
- 套件直接调用的脚本：`run-dsh-compatibility.mjs`、`dsh-cli-isolate.mjs`、`build-client.mjs`、`check-feedback-policy.mjs`、`verify-package.mjs`、`verify-dsh-install.mjs`
- `tsconfig.json`、`tsconfig.base.json`、`vitest.config.ts`、`tsup.config.ts`、`cordis.patch.yml`
- `package.json` 或 `package-lock.json` 里除版本号以外的改动；看不出差异内容时按高风险处理
- `.github/workflows/` 下的工作流

可以只跑 Ubuntu：

- 文档、WorkBuddy、核心包自己的单元测试
- 不参与兼容套件的脚本，例如候选暂存和发布证据查询
- `tests/**/*.mjs`
- 只改 `package.json` 和 `package-lock.json` 的版本号

分类失败，或这次是直接推到 `main`：跑 Windows。合并后的 main 如果已经有同一文件树的 PR 证据，并且证据覆盖了上面要求的系统，就复用，不再重跑。

正式发布用同一套规则。高风险提交的证据必须包含 Windows。只改版本号或文档时，可以复用只有 Ubuntu 的同树证据。手动发布不查 PR 接口，直接看该提交在 main 上的 CI：要么包含 Windows 的矩阵任务都成功，要么 `reuse-pr-ci` 已经成功。后者表示 main 当时已经按上面的规则接受了 PR 证据，0.3.42 的正式发布就是靠这条记录通过的。

历史宿主全矩阵仍由定时或手动工作流运行，不进每个 PR。时间仍是每天 02:30（Asia/Shanghai）。代表宿主任务的上限是 90 分钟。已经成功过的 Windows 任务大约 47 分钟，上限留在这之上；仓库 `npm ci` 另有 20 分钟上限。一个任务失败或超时不会取消其他系统上的任务。

同一次任务里，选定的宿主 CLI 只安装一次，并使用和真实宿主冒烟相同的版本钉扎。包校验把这棵树复制到单独目录，把已经装好的精确版本同时写进 dependencies 和对应 override，再安装待测 tarball。两处字符串保持一致，npm 才不会因说明不一致拒绝安装，也不会把宿主包当成多余依赖删掉。真实宿主冒烟也复制这棵树，然后继续做 plugin 安装、修复、Web 启动、会话页和迁移。复制出来的符号链接如果指向树的外面，就丢掉这次复制并重新安装。

Actions 缓存按操作系统、DSH 版本、Node 版本和 `scripts/dsh-cli-isolate.mjs` 的内容保存这棵树。还原之后核对 CLI 版本、`lib/bin.js`、已装包指纹，以及钉扎的依赖名和版本字符串是否仍与当前仓库一致。键顺序不同不算变化；版本字符串变了就删除整目录并重新安装，不在半截目录上继续。已经写入的坏缓存不能原键覆盖；下次还会被拒绝并重装，直到隔离脚本变化。日志里的 `[dsh-isolate]`、`[verify-package]`、`[verify-dsh-install]` 会写明复用还是重装。

比较 Windows 耗时时，看 `dsh-compatibility (windows-latest, 0.1.2-rc.1)`、`0.1.7-rc.2` 和 `0.2.2-rc.1` 的总时长。改动前的 [run 42344461565](https://github.com/diqierjia/StrataGate-AgentMemory/actions/runs/42344461565) 大约是 15、23、36 分钟；其中当前宿主的套件步骤里，隔离安装约 9 分钟（652 个包），包校验约 11.5 分钟，安装冒烟约 8.5 分钟。仓库 `npm ci` 当时已经命中缓存。第一次运行含安装和缓存上传，之后的同键运行才是命中。
