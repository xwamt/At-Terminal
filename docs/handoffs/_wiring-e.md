# Wiring — slice E（ux-release）

跨所有权补丁。SftpTreeProvider 补丁须在 **slice C 合入之后** 再打。上一轮 `_wiring-agent.md` 等不要重放。

## SftpTreeProvider：none 状态返回空数组以显示 viewsWelcome

`src/tree/SftpTreeProvider.ts` 由 C 拥有。`getChildren` 内：

```ts
if (state.kind === 'none') {
  return [];
}
```

若因此不再使用 `SftpPlaceholderTreeItem`，删除该 import（类留在 `SftpTreeItems.ts`）。`disconnected` 快照分支不变。

配套：`test/tree/SftpTreeProvider.test.ts` 中 none 状态 `getChildren()` 断言改为 `[]`，替换现有 placeholder 断言。

## ServerFormPanel：keepAlive 表单默认值改读设置

`src/webview/ServerFormPanel.ts` 两处 `?? 30` / `value="${server?.keepAliveInterval ?? 30}"` 改为 `resolveKeepAliveInterval({}, vscode.workspace.getConfiguration('sshManager'))` 在 open/render 处求值一次后传入模板。与 B/C 表单改动冲突时后合者手工套用。

## 认证分类器接线（B 合入后）

若 B 导出 `classifySshError(error).code === 'auth-failed'`，把 `TerminalPanel.ts` 的 `isLikelyAuthenticationError` 改为委托该分类器；函数签名与调用点不变。B 未合入则维持字符串匹配。

## l10n zh-cn 新增条目（与 A 并集合并）

E 在自己分支可直接向 bundle 追加（纯新增、字母序），不得改 A 已有条目。键值：

| English source | 建议中文 |
| --- | --- |
| `A saved SSH terminal could not be restored because its server no longer exists.` | `无法恢复已保存的 SSH 终端：对应的服务器已不存在。` |
| `Authentication to {label} failed: {message}` | `连接 {label} 时身份验证失败：{message}` |
| `Automatic MCP config supports Kiro, Cursor, and Continue (with an open workspace). Detected IDE: {hostApp}. Use "Copy Manual Config" to configure any other MCP client.` | `自动写入 MCP 配置目前支持 Kiro、Cursor 和 Continue（需要打开工作区）。检测到的 IDE：{hostApp}。其他 MCP 客户端请点击“复制手动配置”自行配置。` |
| `Copy Manual Config` | `复制手动配置` |
| `Edit Server` | `编辑服务器` |
| `Manual MCP config copied to the clipboard.` | `手动 MCP 配置已复制到剪贴板。` |
| `No MCP config was removed. Automatic MCP config supports Kiro, Cursor, and Continue. Detected IDE: {hostApp}.` | `未移除任何 MCP 配置。自动管理仅支持 Kiro、Cursor 和 Continue。检测到的 IDE：{hostApp}。` |
| `No SSH servers configured yet. Add one to get started.` | `还没有配置 SSH 服务器。先添加一台开始使用。` |
| `No SSH terminal is open for {label}.` | `{label} 当前没有打开的 SSH 终端。` |
| `Open a workspace folder so the Continue MCP config can be written to .continue/mcpServers/at-terminal.yaml.` | `请先打开一个工作区文件夹，Continue 的 MCP 配置才能写入 .continue/mcpServers/at-terminal.yaml。` |
| `Open Usage Guide` | `打开使用教程` |
| `Reconnect stopped: authentication failed. Edit the server credentials and retry.` | `已停止重连：身份验证失败。请编辑服务器凭据后重试。` |
| `Restored session. Press Reconnect to connect.` | `会话已恢复。点击“重新连接”以连接。` |
| `Retry` | `重试` |

`Add Server` 已存在。nls 键见 `plans/slice-e-ux-release.md` §6.1。
