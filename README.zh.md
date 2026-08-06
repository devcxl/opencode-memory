<div align="center">

# @devcxl/opencode-memory

[![npm version](https://img.shields.io/npm/v/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![npm downloads](https://img.shields.io/npm/dm/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![license](https://img.shields.io/npm/l/@devcxl/opencode-memory)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/devcxl/opencode-memory/ci.yml?branch=main)](https://github.com/devcxl/opencode-memory/actions)

[English](./README.md) | [中文](./README.zh.md)

基于 Markdown 的 OpenCode 简易记忆插件。

</div>

## 安装

在 `~/.config/opencode/opencode.json` 中添加插件配置：

```json
{
  "plugin": ["@devcxl/opencode-memory"]
}
```

## 记忆文件

| 文件 | 用途 |
|------|------|
| `MEMORY.md` | 长期记忆（关键事实、决策、偏好） |
| `IDENTITY.md` | AI 身份（名称、人格、行为准则） |
| `USER.md` | 用户档案（名称、偏好、上下文） |
| `daily/YYYY-MM-DD.md` | 每日日志（日常活动记录） |
| `BOOTSTRAP.md` | 首次运行引导说明（引导完成后删除） |

## 存储位置

- **macOS/Linux**: `~/.config/opencode/memory/`
- **Windows**: `%APPDATA%/opencode/memory/`

## 工具: memory

**操作:**

| 操作 | 描述 | 参数 |
|--------|-------------|------------|
| `read` | 读取记忆文件 | `target`: memory, identity, user, daily; `date`, `scope`（可选） |
| `write` | 写入记忆文件 | `target`, `content`, `mode`: append/overwrite; `date`, `scope`（可选） |
| `edit` | 编辑文件中的指定内容 | `target`, `oldString`, `newString`; `date`, `scope`（可选） |
| `delete` | 按时间戳删除条目 | `target`, `timestamp`; `date`, `scope`（可选） |
| `search` | 语义搜索记忆文件 | `query`, `max_results`, `period`, `scope`（可选） |
| `list` | 列出记忆文件 | `period`（可选） |

**示例:**

使用 `--scope project` 操作当前项目记忆。projectId 从 git 自动检测；检测失败时降级为全局记忆。

```bash
memory --action read --target memory
memory --action write --target memory --content "Remember to use PostgreSQL for all projects"
memory --action write --target daily --content "Fixed critical bug in auth module"
memory --action edit --target memory --oldString "Project: Auth Service" --newString "Project: Payment Service"
memory --action delete --target daily --timestamp "2026-06-06 15:40:23"
memory --action search --query "PostgreSQL"
memory --action search --query "bug" --period 2026-06 --scope project
memory --action list
memory --action list --period 2026-06
memory --action write --target memory --scope project --content "Use port 5432"
```

## 首次运行流程

**重要:** 首次设置必须在 OpenCode **build 模式**（非 plan 模式）下进行。AI 在 plan 模式下无法写入文件。

1. 插件检测到不存在 MEMORY.md
2. 创建 BOOTSTRAP.md 引导说明文件
3. AI 读取 BOOTSTRAP.md 并与用户交互提问
4. AI 将用户回答写入 MEMORY.md、IDENTITY.md、USER.md
5. AI 删除 BOOTSTRAP.md
6. 设置完成

随时可通过 `/memory-init` 手动触发引导流程（仅在记忆系统未完全初始化时可用）。

## 上下文注入

MEMORY.md、IDENTITY.md 和 USER.md 会在会话开始时自动注入到 system prompt 中。

每日日志需通过 `memory` 工具访问。

## 仓库结构

本仓库是 pnpm monorepo。发布到 npm 的插件位于 `apps/plugin`，Cloudflare Workers 后端与 Web 管理后台各为独立子包。

```
opencode-memory/
├── apps/
│   ├── api/            # @devcxl/opencode-memory-api     Cloudflare Worker 后端
│   ├── plugin/         # @devcxl/opencode-memory         发布到 npm 的 OpenCode 插件（即本 README）
│   └── web/            # @devcxl/opencode-memory-web     Web 管理后台
├── packages/
│   └── shared/         # @devcxl/opencode-memory-shared  各包共享类型
├── scripts/            # 运维脚本
└── docs/               # 架构文档、ADR 与任务规格
```

## 许可证

MIT
