# npm 暂存发布

目标是把大包上传、网络重试放在用户认证之前。npm 发布仍走本暂存流程。GitHub 已恢复，用户要求时可以再走 PR、CI、Tag、Release、trusted publishing 或 Roadmap 同步。归档：2026-10～11 封禁期间，D1 仅走 npm。

## 前置条件

- 用户已验收候选并明确授权正式发布；本脚本不会代替验收、源码审查或相关测试。
- 正式源码已固定，版本和锁文件一致，正式 `.tgz` 已构建、校验并记录 SHA-256。不得用候选版本代替正式版本，也不重新打包覆盖原文件。
- 正式包内 `README.md` 和 `README.zh-CN.md` 必须与已审查源码字节一致；本地图片和文档链接必须存在。`status` 和 `stage` 共用这一检查，避免 npm 展示旧 README。
- 使用满足项目 engines 的 Node，及支持 `npm stage publish/list/view/download/approve` 的 npm CLI。
- 复用现有 npm 登录。只有登录确实不可用时才要求用户登录；发布认证与账号登录是两件事。

## 执行

使用 `scripts/release-npm.mjs`；所有路径参数可为绝对路径。以下 PowerShell 变量需替换为本次真实证据，不要复制历史临时 npm 路径或硬编码 registry IP：

```powershell
$releaseArgs = @(
  '--artifact', '<已校验的正式包.tgz>',
  '--sha256', '<审查时记录的SHA-256>',
  '--evidence', '<本次独立证据目录>',
  '--npm-cli', '<支持stage的npm-cli.js>',
  '--userconfig', '<当前有效的npmrc>'
)
node scripts/release-npm.mjs @releaseArgs --action status
node scripts/release-npm.mjs @releaseArgs --action stage
# validating 时等待后再执行 stage，复用同一个 stageId，不重新上传。
# STAGE_VERIFIED 后，才进入需要用户在 Edge 完成认证的步骤。
node scripts/release-npm.mjs @releaseArgs --action approve
node scripts/release-npm.mjs @releaseArgs --action verify
```

`status` 为默认操作，只查询远端、记录本地状态；已发布但尚未做完整下载核验时返回 `PUBLISHED_NEEDS_VERIFICATION`，执行 `verify` 下载核验即可，不再上传或认证。`stage` 上传或复用暂存包，并下载比对 SHA-256；`approve` 只批准已有、通过字节校验的暂存包，不会上传新包，批准成功后自动核验公开包。发布过程中保持进程运行，给用户实际返回的认证链接，禁止打开内置浏览器。用户确认完成后先检查原进程，不要另起一条 approve。

脚本保留 `npm-release-state.json` 和下载的暂存包，使用进程锁避免同一证据目录并发认证。记录不包含 npm token、OTP 或 npmrc 内容。脚本只调用官方 registry，不关闭 TLS 校验，也不更改系统代理或 DNS。

## 中断恢复

- 每次先查公开版本：同版本内容一致就核验并结束，不再上传或认证；内容冲突则停止。tag 不一致单独报告，不重新发布。
- 上传结果不明：先 `status`，远端存在匹配暂存包就复用。无远端记录时不自动再次上传；核实失败后才用 `stage --retry-upload`。本地没有记录时也会查询远端，避免跨进程重传。
- 认证或批准请求断线：先检查原进程、公开版本和 stage 状态。脚本保留 `APPROVAL_UNCERTAIN`，不自动再认证。确认确实未发布且需要重试后才用 `approve --retry-approval`。
- 原进程仍运行时等待原进程；不要创建新认证链接。失效链接只在实际重新发起必要认证时替换。
- 网络、权限、服务器校验失败时保留包和证据，先排查原因，不退回直接 `npm publish` 循环，不通过关闭二次认证来减少操作。

通常只需要最后一次发布认证；登录过期、认证链接过期或服务端明确要求时仍可能需要额外认证，不能保证永远只有一次。

## 本地验证脚本

```powershell
node --test tests/npm-release.test.mjs
```

测试使用模拟 npm 和 registry，覆盖恢复、重复上传防护、认证失败和字节冲突，不访问真实发布接口。
