# ADR: OpenCode V2 兼容采用 V2-only 2.0.0

> 日期: 2026-11-15 | 状态: Accepted | 关联: `docs/dev/research/opencode-v2-plugin-compat.md`

---

## 背景

OpenCode V2 的插件 API 与 V1 不兼容：

- V1 插件是返回 tools/hooks 对象的函数；V2 默认导出 `{ id, setup(ctx) }`
- V1 的 `config` / `event` / `experimental.chat.system.transform` / `tool` map 均有不同替代
- 官方明确：V1 实现不会在 V2 中运行，移动文件或改配置项名称不够

仓库当前 `@devcxl/opencode-memory@1.2.0` 是纯 V1 插件。需要决定升级策略：

1. 同包双入口（`{ ...Plugin.define(...), server() }`），同时支持 V1 ≥1.18.29 与 V2
2. V2-only major（`2.0.0`），V1 留在 `1.2.x`
3. 拆成不同包名

## 决策

采用 **V2-only major**：`@devcxl/opencode-memory@2.0.0` 只实现 V2 插件 API。

- 入口改为 `Plugin.define({ id: "devcxl.opencode-memory", setup })`
- 移除 `@opencode-ai/plugin`（V1 SDK）与 `"opencode": { "type": "plugin" }` 元数据
- 新增 `@opencode/plugin@^2.3.0` 与 `zod@^4.1.8`
- 包配置示例改为 V2 的 `plugins`
- V1 用户继续使用 `1.2.0`

## 后果

### 正向

- 实现只有一套 API，无双重维护、无双套测试矩阵
- 依赖与入口形态干净，符合 Clean Break
- 可以使用 V2 的 `ctx.options`、`ctx.location`、`ctx.session`、`ctx.tool.transform` 等能力

### 负向 / 需要接受的变更

- 不支持 OpenCode V1
- `/memory-init` 命令常驻，初始化完成后执行时直接返回（V1 中命令会消失）
- `session.idle` 的 TUI toast 在 V2 server 端无等价能力，改为在系统上下文中提醒模型补记 daily
- 项目作用域从进程 cwd 改为 session 的 location，存量 `projects/{owner}/{repo}` 路径保持不变
- 系统上下文在每次模型请求前构建，而不是会话开始只构建一次

### 风险

- `@opencode/plugin@2.3.0` 与 OpenCode CLI 版本需保持兼容；升级 CLI 时需回归验证
- V2 的 `context` hook 在 tool continuation 时也会执行，长会话需关注上下文构建开销
- 多 location 共享 server 时，session → project 的缓存需要正确失效

## 备选方案

- **同包双入口**：一次性覆盖两代，但需维护两套 API、两套测试矩阵，且要求 V1 ≥1.18.29
- **拆包**：隔离彻底但用户需改配置、品牌分裂

## 后续

- 观察 V2 实际使用反馈，再决定是否补充 `./tui` part（toast）与 `./rpc` part（外部查询）
- 若未来需要恢复 V1 支持，从 `1.2.0` 维护线发布补丁，而不是在 `2.x` 上兼容
