<div align="center">

# @devcxl/opencode-memory

[![npm version](https://img.shields.io/npm/v/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![npm downloads](https://img.shields.io/npm/dm/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![license](https://img.shields.io/npm/l/@devcxl/opencode-memory)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/devcxl/opencode-memory/ci.yml?branch=main)](https://github.com/devcxl/opencode-memory/actions)

[English](./README.md) | [中文](./README.zh.md)

基于 Markdown 的 OpenCode 本地记忆插件（仅本地模式）。

</div>

## 该装哪个版本？

本包同时维护两条互不兼容的插件线。请按 **OpenCode 版本**选择，而不是"越新越好"：

| 你的 OpenCode | 安装写法                                                  | 配置键    | 实际版本                                  |
| ------------- | --------------------------------------------------------- | --------- | ----------------------------------------- |
| V1            | `plugin: ["@devcxl/opencode-memory"]` 或固定 `@1.2.1`     | `plugin`  | `latest` → `1.2.1`（V1 维护线）           |
| V2（≥ 2.3.x） | `plugins: ["@devcxl/opencode-memory@v2"]` 或固定 `@2.0.0` | `plugins` | `v2` → `2.0.x`，`rc` → 当前 V2 预发布版本 |

`latest` 刻意停留在 V1 线：V1 用户会被 `latest` 自动更新，而 V2-only 的包在 V1 里根本无法加载。
OpenCode V2 用户必须使用 `@v2` 或精确的 `2.x` 版本。

- 需要 **OpenCode 2.3.x**（运行时依赖 `@opencode/plugin@^2.3.0`）。
- **仅 Linux 经过验证；macOS 与 Windows 未验证。**
- **仅本地模式。** 本仓库不包含远程 Provider、Worker、Web 管理台或共享包。
- 从 V1 迁移、降级或排查失败：见 [docs/migration-v2.md](./docs/migration-v2.md)。

### 远程记忆

远程记忆服务（Cloudflare Worker + Web 管理台）及其客户端已迁移到
[`@devcxl/cabbage-memory`](https://github.com/devcxl/cabbage-memory)。配置里仍写着
`mode: "remote"`（或传入 `remote` 配置块）时会直接报迁移错误，而不会静默退回本地文件。

## 安装

在 OpenCode V2 的 `~/.config/opencode/opencode.json` 中添加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@devcxl/opencode-memory@v2"],
}
```

需要可复现安装时固定精确版本：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@devcxl/opencode-memory@2.0.0"],
}
```

OpenCode V1 的配置键是 `plugin`，并且应使用 V1 线：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@devcxl/opencode-memory"],
}
```

注意：

- V2 读取的是 `plugins`（复数）。残留的 `plugin` 键会被 V2 忽略，插件不会加载，也不会有任何提示。
- `@v2` 是 dist-tag 而非精确版本：未固定的 npm 插件会被 OpenCode 检查更新。需要可复现安装就固定 `@2.0.0`。
- `opencode plugin list` 可以查看实际安装的版本；`opencode plugin check` 会检查可更新版本
  （也可以用 `opencode plugin add @devcxl/opencode-memory@v2` 添加）。
- V2 中的本地插件路径必须指向目录。
- 保留 `optionalDependencies`（`vectra`、`@huggingface/transformers`）。语义搜索需要它们，`--omit=optional` 会让 `search` 失效。

### 嵌入模型选项（可选）

2.0 只剩本地嵌入相关选项。不要再传 `mode` 或 `remote`；`mode: "remote"` 会直接报迁移错误。

对象形式的 `package` 字段同样是一个包 spec：里面要写 `@v2`（或精确版本）。省略版本会解析到
`latest`，也就是 V1 线。

```jsonc
{
  "plugins": [
    {
      "package": "@devcxl/opencode-memory@v2",
      "options": {
        "embeddingModel": "jina-embeddings-v2-base-zh", // 或 nomic-embed-text-v1.5
        "dtype": "fp32", // fp32 | fp16 | q8 | q4 | int8 | uint8
      },
    },
  ],
}
```

默认值：`nomic-embed-text-v1.5`、`fp32`；但当系统 locale 为中文时自动选择
`jina-embeddings-v2-base-zh`。环境变量覆盖：`OPM_EMBEDDING_MODEL`、`OPM_EMBEDDING_DTYPE`，
`OPM_DEBUG=1` 打开调试日志。

## 记忆文件

| 文件                     | 用途                               |
| ------------------------ | ---------------------------------- |
| `MEMORY.md`              | 长期记忆（关键事实、决策、偏好）   |
| `IDENTITY.md`            | AI 身份（名称、人格、行为准则）    |
| `USER.md`                | 用户档案（名称、偏好、上下文）     |
| `daily/YYYY-MM-DD.md`    | 每日日志（日常活动记录）           |
| `projects/<project-id>/` | 项目级记忆与每日日志               |
| `BOOTSTRAP.md`           | 首次运行引导说明（引导完成后删除） |

## 存储位置

- **Linux**: `~/.config/opencode/memory/`
- **macOS**: `~/.config/opencode/memory/`（未验证）
- **Windows**: `%APPDATA%\opencode\memory\`（未验证）

## 工具: memory

**操作:**

| 操作     | 描述                    | 参数                                                                                 |
| -------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `read`   | 读取记忆文件            | `target`: memory, identity, user, daily; `date`, `scope`（可选）                     |
| `write`  | 写入记忆文件            | `target`, `content`, `mode`, `date`, `scope`, `replace_timestamps`, `origin`（可选） |
| `edit`   | 编辑文件中的指定内容    | `target`, `oldString`, `newString`; `date`, `scope`（可选）                          |
| `delete` | 按时间戳删除条目        | `target`, `timestamp`; `date`, `scope`（可选）                                       |
| `search` | 混合检索（向量 + BM25） | `query`, `max_results`, `period`, `scope`（可选）                                    |
| `list`   | 列出记忆文件            | `period`, `scope`（可选）                                                            |

**示例:**

使用 `--scope project` 操作当前项目记忆。projectId 从 session 的 location 通过 git 自动检测；检测失败时降级为全局记忆。

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

`/memory-init` 在 OpenCode V2 中常驻注册，任何时候执行都安全：记忆系统已完全初始化时它会立即返回，
既不创建也不覆盖模板。

## 上下文注入与生命周期

`MEMORY.md`、`IDENTITY.md` 和 `USER.md`（以及当前项目的 `MEMORY.md`，自动剔除 `origin: external` 条目）会拆分为有序 `SystemPart` 注入 system prompt，并通过**会话级冻结快照**保持前缀字节稳定以提升 KV Cache 命中率；仅当本会话修改了注入文件或发生上下文压缩时才失效重建（写入 `daily` 不失效缓存）。每日日志需通过 `memory` 工具主动读取或搜索。

当会话执行过写记忆操作但未更新每日日志时，下一次模型请求末尾会附带独立的 `Memory Reminder` 系统段落。上下文压缩前插件会自动将高价值工程决策沉淀到当日 `daily/`（可通过 `options.compactionFlush: false` 关闭），也可以随时运行 `/memory-consolidate [global] [days]` 将近期日志按字符预算蒸馏归并到 `MEMORY.md`。

## 仓库结构

本仓库是 pnpm monorepo，只包含一个包：发布到 npm 的插件。

```
opencode-memory/
├── apps/
│   └── plugin/         # @devcxl/opencode-memory（即本 README）
├── docs/
│   ├── migration-v2.md # V1 → V2 迁移、降级与排查
│   ├── adr/            # 架构决策记录
│   └── dev/            # 架构流程、发布说明模板、回滚 runbook、RC 验收清单
└── package.json        # workspace 根（private）
```

## 文档

- [迁移指南：V1 → V2](./docs/migration-v2.md) · [Migration guide](./docs/migration-v2.md)
- [架构流程（local-only）](./docs/dev/architecture-flow.md)
- [RC 验收清单与安装 smoke 指南](./docs/dev/release-checklist.md)
- [ADR：OpenCode V2-only 2.0.0](./docs/adr/2026-11-15-opencode-v2-only.md)

## 许可证

MIT
