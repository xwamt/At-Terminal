# AT Terminal MCP 中文文档

**[更适合ai IDE的终端插件](https://github.com/xwamt/At-Terminal)**
----------------------------------------------------------

### 文档入口

[飞书文档](https://my.feishu.cn/docx/BWuvdNdnHoVnzIx7BXEcbAK4nfd?from=from_copylinkhttps://my.feishu.cn/docx/BWuvdNdnHoVnzIx7BXEcbAK4nfd?from=from_copylink)

- [Features](docs/features.md)
- [Usage Guide](docs/usage.md)
- [Chinese documentation](docs/README.zh-CN.md)

### Agent Skills

项目提供符合 Agent Skills 规范的可安装技能。Skills 不复制进 VSIX，用户可以按需安装到 Codex、Claude Code、Cursor、GitHub Copilot 等兼容 Agent，避免在每次对话中重复发送完整运维提示词。

| Skill | 用途 |
| --- | --- |
| [`at-terminal-mcp`](skills/at-terminal-mcp/SKILL.md) | 通过 AT Terminal MCP 安全执行服务器巡检、故障排查、部署、远程命令和 SFTP 操作，并支持结合工作区代码与远程运行状态联合诊断。 |
| [`writing-ops-documents`](skills/writing-ops-documents/SKILL.md) | 生成规范的中文 Markdown 运维文档，包括操作记录、故障排查与 RCA、服务部署、服务巡检、交接和应急预案。 |

使用 `skills` CLI 从 GitHub 按需安装：

```bash
npx skills add xwamt/At-Terminal --skill at-terminal-mcp
npx skills add xwamt/At-Terminal --skill writing-ops-documents
```

Agent 提示词只需指向相应技能：

```text
Use $at-terminal-mcp for SSH servers, remote commands, SFTP, deployments, incidents, and workspace-to-server troubleshooting.
Use $writing-ops-documents for operation records, troubleshooting reports, deployment documents, inspection reports, RCA, and other operations documentation.
```

当两个技能同时适用时，先使用 `$at-terminal-mcp` 收集并验证远程证据，再使用 `$writing-ops-documents` 将事实、推断、操作、验证结果和遗留风险整理为规范文档。

### 两种构建版本

**AT** **Terminal** 是一款面向 VS Code 兼容 IDE 的 SSH 终端与 SFTP 远程文件工作区扩展。它通过标准 SSH/SFTP 协议直接连接远程服务器，不需要在服务器上安装 VS Code Server、Remote Agent 或任何额外服务端组件。

**AT** **Terminal** **MCP** 是 AT Terminal 的 Agent 增强版本。它保留完整的 SSH 终端、SFTP 文件管理和远程文件本地编辑能力，同时通过共享 **AT Series** MCP hub，让 Kiro、Cursor、Continue 等支持 MCP 的 AI IDE 可以通过受控工具读取远程文件、执行非交互命令，并协助完成远程脚本和配置文件维护。

MCP 客户端只配置一条 **AT Series** 入口（`node ~/.at-series/mcp/hub.js`），不再使用 per-plugin `mcp-server.js` 或 VS Code `languageModelTools`。安装命令会写入该入口并迁移掉旧的 `AT Terminal` MCP 条目。架构说明见 [ADR-005](docs/decisions/ADR-005-at-series-hub-adaptation.md)。

项目提供两个面向不同用户的构建版本。

| Capability | Base `AT Terminal` | `AT Terminal MCP` |
| --- | --- | --- |
| SSH terminal and SFTP workspace | Included | Included |
| AT Series MCP hub / bridge | Not included | Included |
| Packaged `dist/hub.js` sync | Not included | Included |
| Installable Agent Skills | Installed separately | Installed separately |

|                              |             |                 |
| ---------------------------- | ----------- | --------------- |
| 能力                           | AT Terminal | AT Terminal MCP |
| SSH 终端                       | 支持          | 支持              |
| SFTP 文件工作区                   | 支持          | 支持              |
| 远程文件本地编辑                     | 支持          | 支持              |
| 资产导入导出                       | 支持          | 支持              |
| AT Series MCP hub / bridge   | 不包含         | 支持              |
| 打包 `hub.js` 同步               | 不包含         | 支持              |
| MCP 配置安装命令                   | 不包含         | 支持              |
| Agent 工具指导文件                 | 不包含         | 支持              |

如果只需要在 IDE 内使用 SSH/SFTP，安装基础版 AT Terminal 即可。如果用户希望 GitHub Copilot Chat、Kiro、Cursor、Continue 等 Agent 调用远程命令或远程文件工具，应安装 AT Terminal MCP。

### 后台连接授权（0.2.17）

为适配当前 **Agent 窗口形态** 的 AI IDE（例如 Codex、Cursor Agent、Kiro 等：对话在独立 Agent 侧，IDE 更多承担扩展宿主角色），AT Terminal MCP 增加了按服务器维度的 **「允许后台连接（Allow background connections）」** 授权。

启用后，Agent 可通过 MCP 在后台发现并连接已授权的 SSH 服务器、执行受控远程命令，而 **IDE 本身可以作为服务基座与资产管理窗口**——负责保存服务器资产、凭据、信任策略与 MCP 桥接，不必始终打开交互式终端会话。

使用说明：

1. 在服务器编辑页先勾选 **Trust agent remote commands**，再勾选其子项 **Allow background connections**。
2. 未授权后台连接的服务器不会出现在 `list_ssh_servers` 中；若前端已打开该服务器终端连接，`run_remote_command` 仍可执行。仅在前端未连接时，才要求勾选后台连接。
3. 旧配置默认关闭后台连接，升级后需按服务器显式开启。

### 本地 MCP Hub 依赖

本仓库通过 `file:` 链接依赖本地 `@at-series/mcp-hub`（路径见根目录 `package.json`）。安装本仓库依赖前，须先在 Hub 仓库对应 worktree 中执行构建（`npm install`、`npm run build -w @at-series/mcp-hub`、`npm run build:hub -w @at-series/mcp-hub`），否则 `require('@at-series/mcp-hub')` / `require('@at-series/mcp-hub/hub')` 可能无法解析。

#### 构建产物

请先安装 Node.js 和 npm。建议使用较新的 Node.js LTS 版本。进入项目根目录后安装依赖：

```bash
#安装依赖
npm install
#打包前可以先执行类型检查和测试，确认当前代码状态正常：
npm run typecheck
npm test
#打包基础版插件
npm run package:base
#打包 MCP 版插件
npm run package:mcp
```

#### 本地安装

打包成功后，项目根目录会生成类似下面的文件：

```textile
at-terminal-mcp-0.2.17.vsix
```

生成 .vsix 后，可以在 VS Code / Cursor / Kiro 等兼容 VS Code 插件的 IDE 中通过“从 VSIX 安装”安装，也可以使用命令行安装

```bash
code --install-extension at-terminal-mcp-0.2.17.vsix
#如果安装基础版，则把文件名替换为实际生成的 at-terminal-*.vsix。
```



### 特色功能

#### 生态适配

* 依托VS CODE插件生态，适配所有VS CODE系列IDE，包括cursor、kiro、Antigravity、Qcode、Trae等主流ai coding IDE。

* 不提供原生agent（因为你再怎么做也比不过大厂）仅提供标准MCP接口，agent能通过接口调用工具。标准mcp接口，也可以被codex和claud code调用

* 厌倦了**Terminal**千篇一律的ui风格，插件能跟随IDE的主题更换UI风格

#### 文件操作

* 查看：在ide里直接查看服务器上文件，实现基于不同文件格式的渲染效果

* 编辑：在ide内编辑文件，使用agent直接写脚本或配置

#### agent

可以基于各ai ide内置agent，调用mcp接口实现下列操作

* 命令执行：agent直接在服务器上执行命令，联合代码与运行情况一同排查

* 文件上传：结合文件上传功能，让agent直接帮你部署服务

* 文件编辑：直接修改服务配置文件



### 功能总览

|           |                                                |
| --------- | ---------------------------------------------- |
| 模块        | 能力                                             |
| SSH 服务器管理 | 添加、编辑、删除、分组展示服务器配置，支持复制连接信息。                   |
| SSH 连接    | 支持密码认证、私钥认证、keep-alive、断开、重连和独立终端标签页。          |
| 主机信任      | 首次连接确认主机指纹，已信任主机指纹变化时阻止连接。                     |
| 跳板机       | 服务器配置可引用 jump host，通过跳板机转发连接目标服务器。             |
| Web 终端    | 基于 xterm.js 渲染终端，支持窗口尺寸同步、主题适配、链接识别和语义高亮。      |
| SFTP 文件视图 | 跟随当前活动 SSH 终端，连接后加载远程登录目录。                     |
| SFTP 文件操作 | 浏览、刷新、跳转路径、返回父目录、上传文件、下载文件、新建、重命名、删除、复制远程路径。   |
| 拖拽上传      | 支持从 VS Code Explorer 拖拽本地文件到 SFTP 视图上传。        |
| 远程预览      | 远程文件可通过预览命令打开，不需要手动下载到用户指定位置。                  |
| 远程文件本地编辑  | 使用 SFTP: Edit 下载远程文件到本地编辑器，保存后上传同步。            |
| 保存同步保护    | 首次自动同步需要用户确认；同步前检测远程文件是否变化；上传后校验远程内容。          |
| lrzsz 检测  | 对终端中的 rz / sz ZMODEM 序列进行保守检测，并启动本地适配流程。       |
| 资产导入导出    | 通过加密 .at-terminal-assets 包迁移服务器配置、可选密码和可选私钥文件。 |
| Agent 工具  | MCP 版提供远程命令、SFTP 读取和 SFTP 写入等工具调用能力。           |
