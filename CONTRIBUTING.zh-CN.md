# 为 StrataGate 做贡献

感谢你帮助改进 StrataGate。代码、测试、文档、问题报告、设计反馈和可复现评测都很有价值。

[English guide](CONTRIBUTING.md)

## 开始之前

- 创建新 Issue 前，请先搜索[已有 Issue](https://gitee.com/diqier4123/StrataGate-AgentMemory/issues)。
- 报告问题时，请注明相关集成、Node.js 版本、复现步骤、预期行为和实际行为。
- 如果准备实现较大的功能或调整架构，请先创建 Issue 讨论方案和范围，再开始开发。
- 不要在 Issue、测试、fixture 或 Pull Request 中提交私人对话、凭据、API Key 或其他敏感信息。安全问题请按照 [`SECURITY.md`](SECURITY.md) 报告。

参与本项目即表示你同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

## 可以贡献什么

以下贡献都很有帮助：

- 修复可复现的问题，或补充回归测试；
- 完善安装、使用、架构或评测文档；
- 改进 `packages/core/` 中的共享记忆引擎；
- 改进 `src/` 中的 DeepSeek Harness 适配层；
- 改进 `integrations/workbuddy/` 等集成；
- 增加说明充分、可复现的 benchmark 或评测；
- 改善无障碍体验、错误提示或开发体验。

我们同样欢迎小而专注的改动。一个 Pull Request 不需要包含大型功能，也可以非常有价值。

## 开发环境

StrataGate 是 npm workspace monorepo。请使用 Node.js `22.19.0` 或更新的 22.x 版本，也可以使用 Node.js 24 及以上版本。运行以下本地检查；2026-11-05 账号恢复后，重新要求完成 GitHub CI。

```bash
git clone https://gitee.com/diqier4123/StrataGate-AgentMemory.git
cd StrataGate-AgentMemory
npm ci
```

运行以下主要本地检查：

```bash
npm run check
npm test
npm run build
```

开发过程中也可以只运行相关部分：

```bash
npm run check:core
npm run test:core
npm run check:dsh
npm run test:dsh
npm run check:workbuddy
npm run test:workbuddy
```

## 修改代码

1. 从最新的 `main` 创建分支。
2. 保持改动聚焦，避免夹带无关的格式调整或重构。
3. 行为发生变化时，请增加或更新测试；修复问题时最好补充回归测试。
4. 面向用户的行为发生变化时，请同步更新相关中英文文档。
5. 提交 Pull Request 前运行覆盖本次改动的检查；条件允许时，请运行完整的类型检查、测试和构建。

记忆系统尤其依赖来源追溯、时间戳、作用域隔离、确定性排序和证据充分性。修改这些部分时，请为相关不变量和边界情况补充有针对性的测试。

## 提交 Pull Request

一份便于审查的 Pull Request 应包含：

- 对问题和解决方案的简洁说明；
- 相关 Issue 或讨论的链接；
- 用于验证改动的测试和命令；
- 可见界面改动的截图或录屏；
- 行为或配置变化所需的文档更新；
- 涉及性能或准确率声明时的评测细节和机器可读产物。

请让提交记录便于审查，并积极回应审查意见。如果 Pull Request 范围过大，维护者可能会建议拆分成多个更小的改动。

## 提交评测结果

评测结论应当可以复现。请记录数据集或子集、模型与配置、提示词、运行次数、评分方法、对比条件和相关产物哈希。请明确区分完整系统对比与单组件消融，并避免把结论推广到未经评测的范围。

## 许可证

提交贡献即表示你同意按本项目的 [MIT License](LICENSE) 授权你的贡献。
