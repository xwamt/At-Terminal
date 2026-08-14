# Phase P2a — AT Terminal 载荷上限（本仓执行）

在 **本仓库** `at-terminal-series`（pluginId `at.terminal`）收紧 MCP 工具大包风险。不要 commit，除非用户另说。

## 背景

相对 Grafana「无上限整板 JSON」，Terminal 的 `run_remote_command` / `sftp_read_file` 已有 64KB 默认 / 256KB 硬顶。主要缺口：

1. **`sftp_list_directory` 无条数上限**（全量 readdir）
2. skill 未强调 maxOutputBytes / truncated
3. 默认 64KB 对 LLM 仍偏大（可选降至 32KB，或维持默认但文档写清）

## 必做

### 1. `sftp_list_directory`

- 增加 `maxEntries`（默认建议 **500**）+ 响应 `truncated: boolean`（可选 `total` / 提示缩小 path）
- 更新 Zod/schema、toolCatalog、AgentToolService / SftpAgentService
- 测试：超限截断与 truncated 标志

### 2. 文档化现有读写上限

- toolCatalog description 写明 `sftp_read_file` / `run_remote_command` 的默认与硬顶
- 更新 `skills/at-terminal-mcp/SKILL.md`（若有）：强调 truncated 时收窄，不要默认 `nginx -T` / `docker compose config` 整包

### 3. （可选）降低默认输出

若改默认（例如 64→32KB），保持硬顶 256KB，并在 description 说明可显式提高。若担心 breaking，可只加 list 上限 + 文档。

## 不要做

- 不要实现通用 Bridge 框架抽到 Hub
- 不要改 Hub progressive discovery 协议
- JumpServer 改动在另一仓，本任务不要碰

## 验收

- 大目录 list 返回 truncated
- schema/测试覆盖
- skill/catalog 提到 payload 纪律

## 完成后

简体中文总结。不要 push/PR，除非用户要求。
