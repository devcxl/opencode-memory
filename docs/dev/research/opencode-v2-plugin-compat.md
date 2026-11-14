# opencode-memory 升级 OpenCode V2 插件兼容性调研

> 研究日期: 2026-11-15 | 状态: 第1轮完成 | 结论: 需要重写插件入口，无法通过改配置直接兼容

---

## 研究结论摘要

**V1 插件实现不会在 V2 中运行。** 官方迁移文档明确说明：V1 插件返回一个包含 tools 和 hooks 的对象，V2 插件的默认导出是带 `id` 和 `setup(ctx)` 的定义，通过 context 按领域注册 hook、transform、tool 与事件订阅；移动文件或改配置项名称都不够，必须移植实现代码。

本仓库当前使用的 8 个 API 面，7 个有明确 V2 对应物，1 个（TUI toast）在 server 端没有等价能力：

| #   | 当前 V1 API（`apps/plugin/src/index.ts`）         | V2 对应物                                               | 结论                                                      |
| --- | ------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| 1   | `Plugin` 函数入口（L50, L380）                    | `Plugin.define({ id, setup })` 默认导出                 | **必须重写**                                              |
| 2   | `config` hook 注入 `command`（L97-124）           | `ctx.command.transform(editor => editor.add(...))`      | 改写，且 transform 必须同步、可重放                       |
| 3   | `command.execute.before`（L126-131）              | command 的 `execute`，或 `ctx.session.hook("prompt")`   | 改写                                                      |
| 4   | `event` hook（L133-172）                          | `ctx.event.subscribe()` 异步迭代 + cleanup              | 改写，payload 从 `event.properties` 变为 `event.data`     |
| 5   | `tool.execute.after`（L174-194）                  | `ctx.tool.hook("execute.after", ...)`                   | 字段改为 `event.input` / `event.status`                   |
| 6   | `experimental.chat.system.transform`（L196-204）  | `ctx.session.hook("context", ...)`，编辑 `event.system` | 改写，注入形状变为 `{ type: "text", text }`               |
| 7   | `tool` map + `tool()` + `tool.schema`（L206-375） | `ctx.tool.transform(editor => editor.add(...))`         | **改动最大**：JSON Schema / Standard Schema，返回值结构化 |
| 8   | `ctx.client.tui.showToast`（L163）                | server 端无等价 API；TUI 插件用 `context.ui.toast.show` | **能力缺失**，需降级或加 TUI part                         |

**推荐策略**：短期采用「同包双入口」同时支持 V1 与 V2（发布 `1.3.x`，要求 V1 ≥ 1.18.29），验证稳定后再发 V2-only 的 `2.0.0`。如果 V1 用户群可以放弃，直接 major bump 到 `2.0.0` 更干净。

**最大隐性风险不是 API 名字，而是作用域语义**：V2 的 server 是共享服务，`ctx.location` 只是插件实例加载位置，不等于每个 session 的位置。当前插件用 `detectProject()` + 进程工作目录推导项目，在 V2 下会把不同项目的 session 混到同一记忆作用域。必须改为按 session 的 `projectID` / `location` 解析。

---

## 1. 背景与范围

### 1.1 版本事实

| 项                | 值                                                 | 来源                                     |
| ----------------- | -------------------------------------------------- | ---------------------------------------- |
| 本机 OpenCode CLI | `v2.3.0`                                           | `opencode --version`                     |
| V2 插件 SDK       | `@opencode/plugin@2.3.0`                           | npm registry                             |
| V2 运行时依赖     | `@opencode/client@2.3.0`、`@opencode/schema@2.3.0` | `@opencode/plugin@2.3.0` 的 dependencies |
| V1 插件 SDK       | `@opencode-ai/plugin@1.19.5`（本仓库锁到 1.18.4）  | npm registry                             |
| 本插件版本        | `@devcxl/opencode-memory@1.2.0`                    | `apps/plugin/package.json`               |

注意包名不是简单升级：V1 是 `@opencode-ai/plugin@1.x`，V2 是 `@opencode/plugin@2.x`；客户端包也从 `@opencode-ai/sdk` 换成 `@opencode/client`。

### 1.2 调研范围

- 当前插件实际使用的 hook / tool / client 能力逐项映射
- V2 插件入口、生命周期、打包与加载方式
- V1/V2 同包兼容的可行性与边界
- 不涉及：memory 业务逻辑重写、远程 Worker API 变更、Web 控制台

### 1.3 一手来源

- V2 官方文档：插件迁移页、server 插件 API、插件总览、插件配置、TUI 插件、RPC
- npm 包内类型定义：`@opencode/plugin@2.3.0`、`@opencode/schema@2.3.0`、`@opencode/client@2.3.0`
- 本机安装的 OpenCode `v2.3.0`

文档与类型定义冲突时以类型定义（源码产物）为准，并在文中标注「源码已确认」。

---

## 2. V2 插件模型

### 2.1 一个包，多个 part

V2 插件是一个 npm 包，可包含 server / TUI / GUI / RPC 任意组合，每个 part 是包的子导出：

```json
{
  "name": "opencode-acme-plugin",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./rpc": "./src/rpc.ts"
  },
  "dependencies": { "@opencode/plugin": "latest" }
}
```

- server part（`.` 或 `./server`）运行在 OpenCode server，提供 tools、hooks、commands、agents 等
- TUI part（`./tui`）通过 `@opencode/plugin/tui` 扩展终端 UI
- GUI part（`./gui-experimental`）扩展 Desktop
- RPC part（`./rpc`）给其它 part 和客户端提供类型化方法/事件

来源：[Plugins Overview](https://opencode.ai/docs/build/plugins/)、[Server](https://opencode.ai/docs/build/plugins/server/)

### 2.2 入口形态

```ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true);
    return () => {
      // cleanup：定时器、子进程、socket、事件订阅
    };
  },
});
```

- `id` 必须稳定：插件存储按 id 隔离，状态与诊断也用它标识插件
- `setup` 可异步，返回 cleanup 函数；hook / transform 注册随插件卸载自动清理
- `Plugin.define` 在源码中只是恒等函数（`package/dist/promise/plugin.js`），但使用它可获得类型检查

来源：[Migrate plugins from V1](https://opencode.ai/docs/build/plugins/migrate-v1/)、npm `@opencode/plugin@2.3.0` → `dist/promise/plugin.d.ts`、`plugin.js`（源码已确认）

### 2.3 context 就是客户端

V2 的 `ctx` 同时是 OpenCode client 与插件 API，按领域分组，不再有单独的 `client` 属性：

| V1                              | V2                                                         |
| ------------------------------- | ---------------------------------------------------------- |
| `directory`                     | `ctx.location.directory`                                   |
| `project`                       | `ctx.location.project`（`id` / `directory` / `canonical`） |
| `client`                        | `ctx.session`、`ctx.permission`、`ctx.tool` 等领域方法     |
| 插件 options 参数               | `ctx.options`                                              |
| 返回 `dispose()`                | `setup` 返回 cleanup 函数                                  |
| 返回 `event` hook               | `ctx.event.subscribe()`                                    |
| 返回 config / model / tool 变更 | 对应领域的 `transform(...)`                                |

`ctx.location` 的准确定义：**当前插件实例加载的位置**，不是它观察到的每个 session / event 的位置；需要区分时必须读 session 或 event 数据。

来源：[Migrate plugins from V1](https://opencode.ai/docs/build/plugins/migrate-v1/)、npm `@opencode/plugin@2.3.0` → `dist/promise/plugin.d.ts`、`@opencode/schema@2.3.0` → `dist/location.d.ts`（源码已确认）

### 2.4 配置与加载

V2 配置键是 `plugins`（数组），V1 是 `plugin`；V2 支持包名、带版本、scoped 包、本地目录、`file://` 以及带 options 的对象形式：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@devcxl/opencode-memory",
    { "package": "@devcxl/opencode-memory", "options": { "mode": "local" } },
  ],
}
```

- 配置中的本地路径必须是**目录**，指向单文件会被跳过并告警
- `.opencode/plugins/` 自动发现；全局目录 `~/.config/opencode/plugins/`
- 多个配置文件的 `plugins` 数组按优先级合并，而不是互相覆盖
- 支持 `-` 前缀、`*`、`.*` 禁用/启用
- 已安装包插件在启动时先加载缓存，后台安装缺失包并检查更新

来源：[Plugins 配置页](https://opencode.ai/docs/plugins/)、[Plugins Overview](https://opencode.ai/docs/build/plugins/)

### 2.5 事件与 hook 的差别

V2 有两套拦截机制：

- **hook**：拦截正在发生的操作（`ctx.session.hook("context")`、`ctx.tool.hook("execute.after")`、`ctx.shell.hook("create.before")`）
- **transform**：对领域状态做同步、可重放的编辑（`ctx.tool.transform`、`ctx.command.transform`、`ctx.model.transform`）

transform 回调必须同步、廉价、无一次性副作用；外部数据要在注册前加载好，数据变化后调用对应领域的 `reload()` 重放。

来源：[Server API](https://opencode.ai/docs/build/plugins/server/)、[Migrate plugins from V1](https://opencode.ai/docs/build/plugins/migrate-v1/)

---

## 3. 当前插件的逐项迁移

### 3.1 入口与 context

**现状**：`export const MemoryPlugin: Plugin = async (ctx: PluginInput) => { ... }`，随后 `export default MemoryPlugin`（`apps/plugin/src/index.ts:50,380`）。依赖 `ctx.client` 与 `ctx.directory`（项目检测）。

**V2**：

```ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "devcxl.opencode-memory",
  async setup(ctx) {
    // 初始化 config / providers / MemoryManager
    // 注册 command / tool / hooks / event subscription
    return () => controller.abort();
  },
});
```

要点：

- `id` 建议使用带命名空间的形式（如 `devcxl.opencode-memory`），避免与其它插件冲突
- `setup` 里可以 `await` 远程 provider 初始化，这一点比 V1 更合适
- 初始化失败应抛出，让插件加载失败可见，而不是吞掉异常

来源：[Migrate plugins from V1](https://opencode.ai/docs/build/plugins/migrate-v1/)

### 3.2 `config` hook → `ctx.command.transform`

**现状**：`config` hook 里仅当 `getInitState() !== "ready"` 时向 `cfg.command` 注入 `memory-init` 命令（L97-124）。

**V2**：

```ts
await ctx.command.transform((editor) => {
  editor.add({
    name: "memory-init",
    description: "Initialize OpenCode memory system (first-time setup)",
    execute: async ({ sessionID, prompt, delivery }) => {
      if (memoryManager.getInitState() === "ready") return;
      await bootstrapManager.createInitTemplates();
      await ctx.session.prompt({
        sessionID,
        text: MEMORY_INIT_PROMPT,
        delivery,
      });
    },
  });
});
```

差异与注意：

- V2 没有全局可变 config 对象；命令必须注册到 `ctx.command`
- `CommandDefinition` 只有 `name`、`description`、`execute`，没有 V1 的 `template` 字段；需要在 `execute` 里自行 `ctx.session.prompt`
- `execute` 收到 `{ sessionID, prompt, delivery }`，`prompt` 是 `PromptInput.Prompt`（`text` + 可选 files/agents/skills）
- transform 回调同步；`getInitState()` 是同步 fs 检查，可以在注册前读取并捕获，但状态变化后需要 `ctx.command.reload()` 才会重放
- 行为差异：V2 无法像 V1 一样在初始化完成后让命令从列表消失（除非主动 reload）。更简单的做法是命令常驻，`execute` 内判断状态后直接返回

来源：[Server – Commands](https://opencode.ai/docs/build/plugins/server/#commands)、npm `@opencode/plugin@2.3.0` → `dist/promise/command.d.ts`、`@opencode/schema@2.3.0` → `dist/prompt-input.d.ts`（源码已确认）

### 3.3 `command.execute.before` → command 的 `execute`

**现状**：拦截 `memory-init`，创建 BOOTSTRAP / MEMORY / IDENTITY / USER 模板（L126-131）。

**V2**：直接并入上一节的 `execute` 即可。官方明确说 `command.execute.before` 没有一对一全局 hook：

- 插件拥有该命令时，用 `ctx.command.transform` 注册命令
- 真实意图是修改所有来源提交的 prompt 时，用 `ctx.session.hook("prompt")`

本插件的意图是「执行自己的命令时准备文件 + 发送初始化提示」，属于前者。

来源：[Migrate plugins from V1](https://opencode.ai/docs/build/plugins/migrate-v1/)、[Server – Commands](https://opencode.ai/docs/build/plugins/server/#commands)

### 3.4 `event` hook → `ctx.event.subscribe`

**现状**：处理 `session.created` / `session.deleted` / `session.idle`，并从不同字段取 sessionID（L133-172）：

```ts
const sessionID =
  event.type === "session.idle"
    ? event.properties.sessionID
    : event.type === "session.created" || event.type === "session.deleted"
      ? event.properties.info.id
      : undefined;
```

**V2 payload 变化（源码已确认）**：

| 事件              | V1 取法                      | V2 取法                |
| ----------------- | ---------------------------- | ---------------------- |
| `session.created` | `event.properties.info.id`   | `event.data.sessionID` |
| `session.deleted` | `event.properties.info.id`   | `event.data.sessionID` |
| `session.idle`    | `event.properties.sessionID` | `event.data.sessionID` |

V2 事件是 `{ id, created, type, location?, data }` 形状；`session.created` 还带 `durable` 与 `data { sessionID, projectID, location, subpath?, parentID? }`。`session.idle` 不是 durable 事件。

**V2 写法**：

```ts
const controller = new AbortController();

void (async () => {
  for await (const event of ctx.event.subscribe({
    types: ["session.created", "session.deleted", "session.idle"],
    signal: controller.signal,
  })) {
    if (event.type === "session.created") {
      sessionStates.set(event.data.sessionID, {
        memoryOperations: [],
        lastDailyUpdate: null,
      });
    }
    if (event.type === "session.deleted") {
      sessionStates.delete(event.data.sessionID);
    }
    if (event.type === "session.idle") {
      // 提醒逻辑
    }
  }
})();

return () => controller.abort();
```

注意：

- 必须从 `setup` 返回的 cleanup 里 abort，否则插件卸载后订阅泄漏
- `types` 过滤可让类型收窄到对应事件
- server 插件永远不会收到 `server.connected`（它就在 server 内）
- V2 另有 `ctx.session.hook("experimental.idle", ...)`（`SessionIdle` 带 `sessionID` 与 `background` 数组），可作为替代，但标记为 experimental；公共事件流更稳

来源：[Server – Events](https://opencode.ai/docs/build/plugins/server/#events)、npm `@opencode/client@2.3.0` → `dist/promise/generated/types.d.ts`（`SessionCreated` / `SessionDeleted` / `SessionIdle`）、`@opencode/plugin@2.3.0` → `dist/promise/session.d.ts`（源码已确认）

### 3.5 `tool.execute.after` → `ctx.tool.hook("execute.after")`

**现状**：`input.tool`、`input.sessionID`、`input.args`，记录 memory 调用（L174-194）。

**V2**：

```ts
await ctx.tool.hook("execute.after", (event) => {
  if (event.tool !== "memory") return;
  const state = sessionStates.get(event.sessionID);
  const input = event.input as MemoryCallArgs;

  if (event.status === "completed" && state) {
    state.memoryOperations.push({
      action: input.action ?? "unknown",
      target: input.target ?? "unknown",
      timestamp: new Date().toISOString(),
    });
    if (input.target === "daily")
      state.lastDailyUpdate = new Date().toISOString();
  }
});
```

差异（源码已确认）：

- 字段从 `input.args` 改为 `event.input`
- 新增 `event.status`：`"completed"` 带 `result`，`"error"` 带 `error`（`Tool.Error`）
- 事件还带 `agent`、`messageID`、`id`（tool call ID）
- 只有成功完成才应该记录 daily 更新；V1 版本不区分失败/成功，V2 可以顺带修正

来源：[Server – Tools Hooks](https://opencode.ai/docs/build/plugins/server/#tools)、npm `@opencode/plugin@2.3.0` → `dist/promise/tool.d.ts`（`ToolHooks`）（源码已确认）

### 3.6 `experimental.chat.system.transform` → `ctx.session.hook("context")`

**现状**：把 `buildContext()` 结果与 instruction 拼成字符串 push 到 `output.system`（L196-204）。

**V2**：

```ts
await ctx.session.hook("context", async (event) => {
  const memoryContext = await buildContext(resolveProjectId(...))
  if (!memoryContext) return
  event.system.push({
    type: "text",
    text: memoryContext + getMemoryInstructions(),
  })
})
```

差异（源码已确认）：

- `output.system` 是 `SystemPart[]`，每项至少 `{ type: "text", text }`，可选 `cache`、`metadata`
- 回调可以异步，但它在**每次模型请求前**执行；`context` hook 覆盖 agent loop（含 tool continuation），`compaction` / `generate` / `title` 需要分别注册
- 这意味着 `buildContext()` 会按模型调用次数反复读文件。当前每次都读 MEMORY / IDENTITY / USER / daily，V2 下建议加内存缓存，并在 memory 写入成功后失效
- `event.system` 中已有 OpenCode 自身的指令段；可通过 `metadata.experimental.instructions` 区分来源（实验性）
- 只影响出站请求，不写入持久历史

来源：[Server – Model requests](https://opencode.ai/docs/build/plugins/server/#model-requests)、[Migrate plugins from V1](https://opencode.ai/docs/build/plugins/migrate-v1/)、npm `@opencode/ai@2.3.0` → `dist/schema/messages.d.ts`（`SystemPart`，源码已确认）

### 3.7 tool 注册：变化最大的部分

**现状**：`tool({ description, args, execute })`，schema 用 `tool.schema`（zod），`execute` 直接返回字符串（L206-375）。

**V2**：

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "memory",
    description: MEMORY_TOOL_DESCRIPTION,
    input: MemoryInputSchema, // Zod 4 schema 或 JSON Schema 均可
    async execute(input, context) {
      await memoryManager.ensureDirectories();
      validateAction(input.action);
      // ...现有 handle* 分发
      return { content: result };
    },
  });
});
```

源码级差异：

- `Tool.Info` 必填 `name`、`input`、`description`、`execute`；可选 `output`、`freeform`、`options`
- `input` 接受三类值：Effect `Schema.Codec`、任何 Standard Schema（Zod / Valibot / ArkType）、JSON Schema
- `execute` 返回 `Tool.Result`：`{ content?: string | Content[], output?: unknown, metadata? }`；`Content` 是 `{type:"text",text}` 或 `{type:"file",uri,mime,name?}`
- `execute` 第二参数提供 `sessionID`、`agent`、`messageID`、`id`、`signal`、`progress`
- `signal` 需要工具主动读取才会启用协作式取消；本插件的 fs 操作很快，可以暂不处理
- `ctx.tool.transform` 是异步调用，但回调必须同步；`memoryManager` 等依赖在 setup 中创建、闭包捕获即可
- 工具名冲突时后注册者覆盖；可用 `editor.namespace(...)` 归组，但会改变有效工具名（`namespace_name`）

**V1/V2 复用建议**：

- 把参数定义抽成一个共享的 Zod 4 对象 `MemoryInputSchema`；V1 用 `MemoryInputSchema.shape` 作为 `args`，V2 直接把整个对象作为 `input`
- 需要直接依赖 `zod@^4.1.8`（`@opencode/plugin@2.3.0` 与 `@opencode-ai/plugin@1.19.5` 都依赖该版本，但不应依赖传递依赖）
- 也可以用 `z.toJSONSchema(...)` 生成 JSON Schema，但 Zod 原对象本身已是 Standard Schema，类型推导更好

来源：[Server – Tools](https://opencode.ai/docs/build/plugins/server/#tools)、[Migrate – Migrate custom tools](https://opencode.ai/docs/build/plugins/migrate-v1/#migrate-custom-tools)、npm `@opencode/schema@2.3.0` → `dist/tool.d.ts`、`@opencode/plugin@2.3.0` → `dist/promise/tool.d.ts`（源码已确认）

### 3.8 `ctx.client.tui.showToast`：server 端能力缺失

**现状**：`session.idle` 时通过 `ctx.client.tui.showToast(...)` 提示更新 daily log（L163-169）。

**V2 事实**：

- `Context` 中没有 `client` 属性，也没有 `tui` 域；`ctx.app` 只有 `name` / `version` / `channel`
- `ctx.client` 在 V2 中不存在，客户端能力被拆到 `ctx.session`、`ctx.tool` 等领域
- TUI 通知属于 TUI part：`context.ui.toast.show({ message, variant, duration, title })`
- 公共事件流里存在 `tui.toast.show` 事件类型，但它是 server → TUI 的事件；server 插件能否主动发布没有文档说明（**未确认**）
- `ctx.rpc.register` 只能发布 `rpc.<id>.<event>` 自定义事件，不能复用 `tui.toast.show`

可选方案：

1. **降级为工具输出提示**（推荐）：在 `memory` 工具的返回内容末尾追加一句「本会话有 N 次记忆操作但尚未更新 daily」，跨 TUI / Web / Desktop 一致，且不需要新 part
2. **无提示**：去掉该功能，减少一个 API 依赖
3. **增加 `./tui` part**：TUI 插件订阅 `ctx.event` 或自定义 RPC 事件后调用 `context.ui.toast.show`；只能覆盖终端，且需要维护第二个 part
4. **保留 RPC + TUI 组合**：server 端 `ctx.rpc.register` 发自定义事件，TUI 端 `context.client.rpc(...)` 订阅；最完整但复杂度最高

来源：[TUI – Dialogs and toasts](https://opencode.ai/docs/build/plugins/cli/#dialogs-and-toasts)、[RPC](https://opencode.ai/docs/build/plugins/rpc/)、npm `@opencode/plugin@2.3.0` → `dist/promise/plugin.d.ts`（`Context` 无 `client`）、`@opencode/client@2.3.0` → `generated/types.d.ts`（`TuiToastShow`）（源码已确认）

### 3.9 打包与发布

**现状**（`apps/plugin/package.json`）：

```json
{
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "opencode": { "type": "plugin" }
}
```

**V2 要求 / 建议**：

- 增加 `exports`，至少 `"."` 指向 `dist/index.js`，与 V2 文档的包布局一致
- 本地加载：配置项必须是目录；目录里的 `package.json` 有 `name` + `exports` 时按 exports 解析 part，否则按根文件名 `server` / `index` / `tui` / `rpc` 解析
- `"opencode": { "type": "plugin" }` 在 V2 文档中没有任何说明；V2 通过默认导出的 `id` / `setup`（以及 `./tui` 等子导出）识别插件。该字段是否被忽略**未确认**，建议保留但不要依赖
- 运行时依赖 `@opencode/plugin` 的版本要与目标 OpenCode 版本兼容；官方建议发布插件时依赖兼容版本，并在真实安装包上测试，而不是只测 workspace link

来源：[Plugins Overview – Publish](https://opencode.ai/docs/build/plugins/#publish)、[Plugins 配置页](https://opencode.ai/docs/plugins/)

---

## 4. V1 + V2 同包兼容

官方支持在一个包的默认导出里同时暴露两种实现：V1 调用 `server()`，V2 读取 `id` 与 `setup()`：

```ts
import { Plugin } from "@opencode/plugin";

export default {
  ...Plugin.define({
    id: "devcxl.opencode-memory",
    async setup(ctx) {
      // V2 注册逻辑
    },
  }),
  async server(input, options) {
    // 现有 V1 逻辑，返回 hooks 对象
  },
};
```

关键约束：

- V1 对象入口自 OpenCode **1.18.29** 起支持；更老的 V1 仍要求函数导出，会直接不兼容
- 两套实现各用各的 API，不会自动翻译
- V2 读取默认导出的 `id` / `setup`，忽略 `server()`；V1 调用 `server()`
- 用 `Plugin.define(...)` 展开可以获得 V2 部分的类型检查

来源：[Migrate – Support V1 and V2 from one package](https://opencode.ai/docs/build/plugins/migrate-v1/#support-v1-and-v2-from-one-package)、[Server – Support V1](https://opencode.ai/docs/build/plugins/server/#support-v1)

### 4.1 两种路线

| 路线                      | 做法                                                                   | 优点                                   | 代价                                                       |
| ------------------------- | ---------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| A. 同包双入口（推荐过渡） | 默认导出 `{ ...Plugin.define(...), server }`；V1 逻辑保持，V2 逻辑新增 | 一次发布覆盖两代；用户无感升级         | 必须支持两套 API；V1 逻辑至少维护一个周期；包体积/依赖变重 |
| B. V2-only major          | 发布 `2.0.0`，入口只保留 V2；V1 留在 `1.2.x` 维护线                    | 实现干净，符合 Clean Break；无双重维护 | V1 用户被切断；需要分支/维护线                             |
| C. 不同包名               | 新包 `@devcxl/opencode-memory-v2`                                      | 完全隔离                               | 用户需要改配置；品牌分裂                                   |

**建议**：

- 若目标是「升级兼容」而不是「抛弃 V1」：选 A，发布 `1.3.0`，在 README 明确 V1 最低 1.18.29
- 若 V1 用户已基本迁移且可以接受破坏：选 B，直接 `2.0.0`
- 不建议 C，除非两套实现长期并行且版本节奏差异很大

### 4.2 双入口的类型与运行时注意

- `@opencode-ai/plugin` 需升到 `^1.19.5`（至少 ≥1.18.29），否则 V1 的 `PluginModule` 类型不覆盖对象入口
- `@opencode/plugin@2.3.0` 若作为运行时依赖被 V1 加载，会连带安装 `effect@4.1.0`、`@opencode/client@2.3.0` 等一套 V2 运行时。可行但偏重
- 如不希望 V1 加载 V2 运行时：V2 部分可以只 `import type { Context } from "@opencode/plugin"`，默认导出普通对象（`Plugin.define` 只是恒等函数，源码已确认），把 `@opencode/plugin` 放到 `devDependencies` 仅用于类型检查。代价是失去运行时 `Plugin.define` 的显式标记
- 无论哪种做法，发布前都要用真实安装包在 **V1 最低版本** 与 **V2 目标版本** 各跑一次

---

## 5. 风险与未确认项

### 5.1 作用域语义（高优先）

- V2 的 server 是共享服务；`ctx.location` 是插件加载位置，不是每个 session 的位置
- `detectProject()` 基于进程 cwd / git，在 V2 下可能对所有 session 返回同一个项目
- 解决方向：维护 `sessionID → projectID / location` 映射
  - `session.created` 事件带 `data.projectID` 与 `data.location`
  - `session.get({ sessionID })` 返回 `Session.Info`，含 `projectID`；`ctx.session.list` 也支持按 project/directory 过滤
- 记忆文件的 `projects/{owner}/{repo}` 目录结构是否要改成 V2 的 `projectID`，需要单独决策；直接用 `projectID` 会破坏存量路径，建议保留 git 推导出的 owner/repo，同时用 `projectID` 做一致性校验

### 5.2 transform 的同步/可重放约束

- `ctx.command.transform`、`ctx.tool.transform` 的回调必须同步、廉价、无一次性副作用
- 当前 `BootstrapManager.createInitTemplates()` 是异步 fs 写入，不能放进 transform 回调；必须放到 command 的 `execute`
- 后续若在 transform 里读取动态配置，需要先加载再闭包捕获，并在变化后 `reload()`

### 5.3 每次模型请求都构建上下文

- `context` hook 在 agent loop 的每次模型调用前运行，包括 tool continuation
- 现有 `buildContext()` 每次都读多个文件；在长会话中会放大 I/O
- 建议：按 sessionID + projectID 缓存内容；memory 工具写入成功后主动失效缓存

### 5.4 通知能力缺失

- server 端没有 toast；`tui.toast.show` 是否可由 server 插件发布**未确认**
- 如果产品上强依赖该提示，需要新增 TUI part 或 RPC，成本明显高于降级为工具输出提示

### 5.5 打包识别未确认

- V2 文档未提及 `"opencode": { "type": "plugin" }` 元数据；未确认是忽略还是仍有用途
- 未确认无 `exports` 的已发布包能否被 V2 正确解析到 `.` part；建议显式加 `exports`
- 未确认 V1 对象入口调用 `server()` 时是否传入完整的 V1 `PluginInput`（官方示例省略了参数）；双入口实现应按 `Plugin` 类型接收 `(input, options)` 并做防御

### 5.6 其它

- V2 工具默认是否进入 Code Mode、是否需要 `options.codemode`，取决于运行模式；当前 `memory` 工具是普通 JSON 工具，不涉及自由文本输入
- 多 location / 多 workspace 下，memory 的全局与项目作用域需要重新验证
- V2 支持 `session.instructions.entry` 这类会话级指令注入，未来可替代部分 system prompt 拼接，但不是本轮必需

---

## 6. 迁移任务清单

### P0（必须，完成才算兼容）

1. **依赖与版本**
   - `apps/plugin/package.json`：新增 `@opencode/plugin@^2.3.0`（或仅 devDependency，见 4.2）
   - `@opencode-ai/plugin` 升到 `^1.19.5`（双入口时）
   - 直接依赖 `zod@^4.1.8`
   - `apps/plugin/package.json` 增加 `exports: { ".": "./dist/index.js" }`
2. **入口拆分**
   - 新增 `apps/plugin/src/v1.ts`：现有 `MemoryPlugin` 逻辑原样迁出，导出 V1 `Plugin`
   - 新增 `apps/plugin/src/v2.ts`：`Plugin.define({ id, setup })` 实现
   - `apps/plugin/src/index.ts` 只保留默认导出：`{ ...v2Definition, server: v1Plugin }`
3. **V2 tool**
   - 抽出 `apps/plugin/src/tool/schema.ts`（Zod 4 对象）
   - `ctx.tool.transform` 注册 `memory`；`execute` 返回 `{ content: string }`
   - 保持 `handleRead/Write/Edit/Delete/Search/List` 业务逻辑不变
4. **V2 hooks**
   - `ctx.session.hook("context")` 注入 `{ type: "text", text }`
   - `ctx.tool.hook("execute.after")` 用 `event.input` / `event.status`
   - `ctx.event.subscribe({ types, signal })` + cleanup abort
   - `ctx.command.transform` 注册 `memory-init`，模板创建与 prompt 发送放在 `execute`
5. **通知降级**
   - 移除 `ctx.client.tui.showToast`；改为工具结果提示（或按 3.8 的方案 3/4 加 TUI part）
6. **配置与文档**
   - README / README.zh.md 增加 V2 配置示例（`plugins`）与 V1 配置示例（`plugin`）
   - 标注支持的 OpenCode 版本矩阵

### P1（建议）

7. **项目作用域修正**
   - 用 session 的 `projectID` / `location` 替代全局 `detectProject()`（见 5.1）
   - 保留存量 `projects/{owner}/{repo}` 路径兼容
8. **上下文缓存**
   - `buildContext()` 加按 session 缓存；memory 写入后失效
9. **命令生命周期**
   - `memory-init` 常驻 + 执行时判断状态；初始化完成后可选 `ctx.command.reload()`
10. **plugin options**
    - 支持 `ctx.options` 传入 mode / remote 配置，减少环境变量依赖

### P2（可选）

11. `./tui` part：toast 与终端内状态提示
12. `./rpc` part：暴露 memory search / stats 给其它插件
13. `ctx.storage` 持久化 session 级提醒状态（当前是内存 Map，重启即丢）
14. Code Mode 命名空间与 `options.codemode` 调优
15. 发布 `2.0.0` V2-only，移除 V1 入口

---

## 7. 验证方案

1. **类型门禁**：`pnpm --filter @devcxl/opencode-memory typecheck`；V1 与 V2 两套入口分别通过类型检查
2. **单元测试**：共享 schema 的 action / target / scope 校验；`execute` 结果包装；V2 事件字段映射
3. **双版本矩阵**：
   - OpenCode `1.18.29`（V1 对象入口最低版本）
   - OpenCode `1.19.5`（V1 最新）
   - OpenCode `2.3.0`（V2 目标）
4. **手动 smoke**（每个版本）：
   - `memory` 工具 read / write / edit / delete / search / list 全动作
   - `memory-init` 首次初始化：模板创建、prompt 发送、BOOTSTRAP.md 删除
   - system prompt 注入：新会话首轮即带 Memory Context
   - `session.idle` 提醒路径（若保留）
   - 插件 reload / unload 后事件订阅停止、无重复注册
5. **多项目验证**：同一 server 下两个不同 project 的 session，各自只注入自己的项目记忆
6. **真实安装包**：`npm pack` 后在干净环境按 `plugins` 配置加载，而不是 workspace link

---

## 8. 参考资料

### 官方文档

- [OpenCode V2 Docs 索引](https://opencode.ai/docs/llms.txt)
- [Migrate plugins from V1](https://opencode.ai/docs/build/plugins/migrate-v1/)
- [Plugins Overview](https://opencode.ai/docs/build/plugins/)
- [Server plugin API](https://opencode.ai/docs/build/plugins/server/)
- [TUI plugin](https://opencode.ai/docs/build/plugins/cli/)
- [Plugin RPC](https://opencode.ai/docs/build/plugins/rpc/)
- [Plugins 配置](https://opencode.ai/docs/plugins/)
- [V1 → V2 总迁移](https://opencode.ai/docs/migrate-v1/)
- [Client](https://opencode.ai/docs/build/client/)

### npm 包与类型（源码已确认）

- `@opencode/plugin@2.3.0`
  - `dist/promise/plugin.d.ts`：`Plugin`、`Context`、`define`
  - `dist/promise/tool.d.ts`：`ToolDomain`、`ToolEditor`、`ToolHooks`
  - `dist/promise/session.d.ts`：`SessionHooks`、`SessionContext`、`SessionIdle`
  - `dist/promise/event.d.ts`：`EventDomain.subscribe`
  - `dist/promise/command.d.ts`：`CommandDefinition`
  - `dist/promise/rpc.d.ts`：`RpcDomain`
- `@opencode/schema@2.3.0`
  - `dist/tool.d.ts`：`Tool.Info`、`Tool.Result`、`Tool.Content`、`ValueSchema`
  - `dist/session.d.ts`：`Session.Info`、`projectID`
  - `dist/location.d.ts`：`Location.Info`、`Project` 元数据
- `@opencode/client@2.3.0`
  - `dist/promise/generated/types.d.ts`：`SessionCreated`、`SessionDeleted`、`SessionIdle`、`TuiToastShow`
- `@opencode/ai@2.3.0`
  - `dist/schema/messages.d.ts`：`SystemPart`
- `@opencode-ai/plugin@1.19.5`
  - `dist/index.d.ts`：V1 `Plugin`、`PluginModule`（`server` 对象入口）
  - `dist/v2/promise/*`：早期 V2 预览 API（与 `@opencode/plugin@2.3.0` 不同，不可混用）

### 本机环境

- `opencode --version` → `v2.3.0`
- 本仓库 V1 SDK 实际安装版本：`@opencode-ai/plugin@1.18.4`
