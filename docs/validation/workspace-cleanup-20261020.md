# 2026-10-20 工作区整理

## 已保存的源码

将 `codex/review-dreaming-stop-20261019` 上此前未提交的工作作为一个完整快照提交，包含 Event 去重与维护、Dreaming 目录占用及原生上下文和概要重写修复、DSH 兼容性检查、WorkBuddy 适配，以及对应测试与文档。基线为 `3e03c685d308cb6eac5a57675bb94cce52c7b0aa`。此前多个任务修改了相同文件，本次保留最终工作树，不重新拆分或改写各任务历史。

## 本次验证

使用本机现有 Node v24.19.0，重新运行以下检查，验证期间源码 SHA-256 无变化。

| 检查 | 结果 |
| --- | --- |
| Core 测试 | 414 通过 |
| DSH 测试 | 866 通过、1 项既有跳过 |
| WorkBuddy 测试 | 10 通过 |
| Core、DSH、WorkBuddy TypeScript | 全部通过 |
| Core、DSH 服务端与客户端、WorkBuddy 构建 | 全部通过 |
| Git 差异空白检查 | 通过 |

原始日志、测试 JSON、源码哈希与整理前状态保存在本地 `.artifacts/workspace-cleanup-20261020/`；`verify.mjs` 记录实际执行参数。没有运行真实模型或操作生产数据库。本次没有打包、候选验收或发布。

默认 PATH 中 Node 为 v22.12.0，低于项目要求的 `^22.19.0 || >=24.0.0`；本次使用 Codex 自带的 `C:/Users/19007/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。未改变其他应用的 Node 安装或系统 PATH；后续手动运行项目命令仍需选择受支持的 Node。

## 分支与证据保留

- 本地历史中的 PR #116、#120、#122 合并提交与祖先检查共同确认 `codex/readme-community-layout`、`codex/topic-section-membership`、`codex/memory-directory-section-titles` 已纳入本地 `main`，已使用 `git branch -d` 删除。README 辅助 worktree 无修改、未跟踪文件或忽略文件，已移除。
- 新提交完成后，本地 `main` 从原基线快进到新提交，再删除已收拢的 `codex/review-dreaming-stop-20261019`。
- 其他旧分支存在未纳入本地主线的提交，或仍由 worktree 使用，予以保留。`codex/issue119-topic-reliability` 的辅助 worktree 留有 24 个未跟踪验证文件，保留该分支和工作目录。
- 原地保留 400 份未跟踪验证文件（含历史快照、测试结果、截图及 SQLite 夹具），逐文件路径、大小和 SHA-256 记录在 `preserved-validation.json`；发布目录顶层文件清单记录在 `preserved-release-files.json`。候选 tgz、评审 ZIP、发布证据、已安装依赖及用户数据均保留。
- 仅在本仓库 `.git/info/exclude` 添加 `/.worktrees/`、`/release-candidates/` 和现有未跟踪验证路径，未修改共享忽略规则。新增规则完整记录于 `local-excludes-added.txt`。这些文件仍在磁盘上，只是不再显示为待提交内容。

## 远端限制

`git ls-remote --heads origin` 返回账号暂停的 HTTP 403，无法核实当前远端分支或执行远端清理。缓存的 `origin/main` 与本地 `main` 在整理前已有分叉（本地独有 3 个提交、缓存远端独有 4 个提交），因此未据此重写或合并主线。未执行 push 或删除远端分支。

GitHub PR、CI、Tag、Release、trusted-publishing 和 Roadmap 同步按用户既有要求跳过；本地已有合并记录用于判断本地分支，不代表重新核验了 GitHub 状态。所有现有 tag 和发布产物均保留。
