# ADR-001：双构建变体（基础版 vs MCP）

## 状态
已接受

## 日期
2026-07-21

## 背景
AT Terminal 服务两类用户：

1. 只需要在 VS Code 兼容 IDE 内使用 SSH 终端 + SFTP 工作区的用户。
2. 还希望 AI Agent（GitHub Copilot Chat、Kiro、Cursor、Continue、Codex、Claude Code 等）通过 Language Model Tools 和 / 或 MCP 调用远程工具的用户。

若维护两套完全独立代码库，会重复 SSH / SFTP 逻辑并加倍修 bug 成本。若把 MCP 依赖与 Agent 面无条件打进所有用户包，会增加攻击面和包体积，对从不启用 Agent 的用户不友好。

## 决策
保持 **一套 TypeScript 代码**，产出两个打包变体：

| 变体 | npm 脚本 | 清单文件 | 编译开关 |
| --- | --- | --- | --- |
| 基础版 `AT Terminal` | `build:base` / `package:base` | `package.base.json` | `__AT_TERMINAL_MCP_ENABLED__ = false` |
| MCP 版 `AT Terminal MCP` | `build:mcp` / `package:mcp` | `package.mcp.json` | `__AT_TERMINAL_MCP_ENABLED__ = true` |

运行时通过 `src/buildFlags.ts` 的 `MCP_ENABLED` 门控 Agent / MCP 注册。MCP 构建会打包 `dist/hub.js`（来自 `@at-series/mcp-hub`）供共享 AT Series MCP 客户端使用；不再产出 per-plugin `dist/mcp-server.js`。

## 备选方案

### 两个仓库
- 优点：Agent 面硬隔离
- 缺点：SSH / SFTP 重复，修复分叉
- 结论：否决，单产品族成本过高

### 单包始终开启 MCP
- 优点：打包更简单
- 缺点：扩大信任面；非 Agent 用户噪音更大；难讲「最小安装」故事
- 结论：现阶段否决，双包更贴合定位

### 运行时插件拆分（MCP 独立扩展）
- 优点：可在 Marketplace 组合安装
- 缺点：要装 / 同步两个扩展；跨扩展 IPC 复杂
- 结论：暂缓；若基础版与 MCP 产品线继续分化可再议

## 后果
- 功能开发必须同时考虑两套 manifest 与激活事件。
- 测试应覆盖包变体契约（`test/package.variants.test.ts` 一族）。
- Agent 工具安全声明只适用于 MCP 构建，但共享的 SSH / SFTP bug 会影响两个包。
- 文档必须清楚区分基础版与 MCP 能力表。

## 后续
- 从单一事实来源生成工具清单，避免 package / server / docs 漂移。
- 保持基础版激活更轻（除非必要，不使用 `onStartupFinished`）。