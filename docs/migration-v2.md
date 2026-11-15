# 迁移指南：V1 → V2（2.0.0）

> 适用：`@devcxl/opencode-memory` 1.2.x → 2.0.x | 更新日期: 2026-11-15

本仓库的 2.0.0 是 **OpenCode V2-only、local-only** 的版本。V1 插件在 OpenCode V2 里不会加载，
V2 插件也无法在 OpenCode V1 里运行。这篇文档说明怎么判断自己该用哪条线、怎么写配置、数据怎么保留、
出问题怎么退回去。

包概览与安装入口：[README.zh.md](../README.zh.md) · [README.md](../README.md)

English version follows the Chinese one in the second half of this file.

---

## 1. 先判断你用哪一代 OpenCode

| 你的运行时              | 安装写法                                          | 实际版本            | 配置键    |
| ----------------------- | ------------------------------------------------- | ------------------- | --------- |
| OpenCode V1             | `plugin: ["@devcxl/opencode-memory"]`             | `1.2.1`（`latest`） | `plugin`  |
| OpenCode V1（固定版本） | `plugin: ["@devcxl/opencode-memory@1.2.1"]`       | `1.2.1`             | `plugin`  |
| OpenCode V2 RC          | `plugins: ["@devcxl/opencode-memory@2.0.0-rc.1"]` | RC                  | `plugins` |
| OpenCode V2 稳定版      | `plugins: ["@devcxl/opencode-memory@v2"]`         | `2.0.x`             | `plugins` |
| OpenCode V2（固定版本） | `plugins: ["@devcxl/opencode-memory@2.0.0"]`      | `2.0.0`             | `plugins` |

要点：

- **`latest` 永远指向 V1 线（`1.2.1`）**。在 V2 里装 `latest` 等于装了一个加载不了的插件。
- V2 用户写 `@v2`（跟随 2.x 补丁）或精确版本（完全可复现）。RC 建议写精确版本，`@rc` 只是便利写法。
- 最低运行时是 **OpenCode 2.3.x**（插件依赖 `@opencode/plugin@^2.3.0`）。

先确认 registry 上的实际指向：

```bash
npm view @devcxl/opencode-memory dist-tags
# 期望：latest = 1.2.x, v2 = 2.0.x, rc = 当前预发布
```

## 2. 升级步骤（V1 → V2）

### 2.1 备份记忆目录

```bash
cp -a ~/.config/opencode/memory ~/.config/opencode/memory.bak-$(date +%F)
```

Windows（未验证）：备份 `%APPDATA%\opencode\memory`。

目录内容说明：

| 路径                                    | 内容                                 |
| --------------------------------------- | ------------------------------------ |
| `MEMORY.md` / `IDENTITY.md` / `USER.md` | 长期记忆、AI 身份、用户档案          |
| `daily/YYYY-MM-DD.md`                   | 每日日志                             |
| `projects/<project-id>/`                | 项目级记忆与日志（路径规则两代一致） |
| `root.index` / `daily.index`            | 本地向量索引，可删，会自动重建       |
| `BOOTSTRAP.md`                          | 仅首次引导阶段存在                   |

V2 复用同一个目录，**不需要搬迁或改名任何文件**。

### 2.2 升级 OpenCode 到 2.3.x

先升级运行时，再改插件配置。插件与 CLI 版本不匹配时，症状通常是插件静默不加载。

### 2.3 改配置键：`plugin` → `plugins`

`~/.config/opencode/opencode.json`（JSONC）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@devcxl/opencode-memory@v2"],
}
```

V2 只读 `plugins`（复数）。把旧条目留在 `plugin` 里不会被读取，也不会报错。
`@v2` 是 dist-tag：OpenCode 会检查未固定版本的更新，需要完全可复现就写精确 `2.0.0`。

同时删掉所有远程字段（`mode`、`remote`、`apiUrl`、`apiKey`）和远程环境变量
（`OPM_MODE`、`OPM_API_URL`、`OPM_API_KEY`）。

### 2.4 重启并确认插件已加载

重启 OpenCode（或执行 `/reload`）。然后用 CLI 确认安装结果：

```bash
opencode plugin list            # 应出现 @devcxl/opencode-memory，版本为 2.0.x
opencode plugin check           # 可选：检查是否有可更新版本
```

如果 `plugin list` 里是 `1.2.x`，说明装的是 `latest`（V1 线）；把配置改成 `@v2` 或精确 `2.0.0` 后重试。

### 2.5 验证 memory 工具与数据

让 agent 依次调用 `memory` 工具，参数如下：

```bash
memory --action list
memory --action read --target memory
memory --action read --target user
memory --action search --query "<你记忆里确定存在的关键词>"
```

检查顺序：`list` 能看到文件 → `read` 能拿到旧内容 → `search` 有结果。
如果 `search` 报模块缺失，见 [第 6 节](#6-常见失败)。

## 3. 远程模式迁移

2.0 不再包含远程能力：没有远程 Provider，也没有 Worker / Web 管理台 / 共享包。
远程记忆现在由 [`@devcxl/cabbage-memory`](https://github.com/devcxl/cabbage-memory) 维护。

如果你的配置里还有：

```jsonc
{
  "plugins": [
    {
      "package": "@devcxl/opencode-memory",
      "options": {
        "mode": "remote",
        "remote": { "apiUrl": "...", "apiKey": "..." },
      },
    },
  ],
}
```

或环境变量 `OPM_MODE=remote`，插件 setup 会直接抛出迁移错误，错误信息会指明
`@devcxl/cabbage-memory`。它**不会**静默退回本地模式，避免你以为自己在用远程记忆、实际写到了本地。

处理方式：

1. 需要远程记忆 → 改用 `@devcxl/cabbage-memory`，按其 README 配置。
2. 只需要本地记忆 → 从本包配置中删除 `mode`/`remote` 与相关环境变量。
3. 远程数据的导出与迁移不在本包范围内，按 cabbage-memory 的说明处理。

## 4. 行为变更（升级后能感知到的差别）

| 变更              | V1                          | V2                                                            |
| ----------------- | --------------------------- | ------------------------------------------------------------- |
| `/memory-init`    | 初始化完成后从命令列表消失  | 常驻注册；已初始化时执行立即返回，不重建模板                  |
| 补记 daily 的提醒 | `session.idle` 弹 TUI toast | 下一次模型请求的 system context 里追加 `Memory Reminder` 段落 |
| 项目作用域        | 按进程 cwd 判定项目         | 按 session 的 location 判定；检测失败降级为全局               |
| 上下文注入时机    | 会话开始构建一次            | 每次模型请求前从磁盘重建并注入（暂无上下文缓存）              |
| 配置键 / 包形态   | `plugin`，V1 插件 API       | `plugins`，`Plugin.define({ id, setup })`                     |
| 远程模式          | 支持 `mode: "remote"`       | 已移除，命中即报迁移错误                                      |

上下文每次都重建意味着长会话的每次请求都会重读 MEMORY / IDENTITY / USER；目前没有缓存，
这是已知限制，不是配置错误。

## 5. 降级与回滚

### 5.1 在 V2 内部回退

```jsonc
{ "plugins": ["@devcxl/opencode-memory@2.0.0"] }
```

或回退到上一个可用的 2.0.x / RC：

```jsonc
{ "plugins": ["@devcxl/opencode-memory@2.0.0-rc.1"] }
```

改完重启 OpenCode。记忆目录不需要动。

### 5.2 不能降级到 1.2.x

**1.2.x 是 V1 插件，OpenCode V2 不加载它。** 把配置改成 `@1.2.1` 只会得到"插件没加载"，
不是"回到旧行为"。要回到 1.2.x 必须**同时把 OpenCode 降级到 V1**：

1. 卸载 / 降级 OpenCode 到 V1（具体版本按 OpenCode 的安装方式回退）。
2. 配置键改回 `plugin`：`"plugin": ["@devcxl/opencode-memory@1.2.1"]`。
3. 记忆目录保持原样，直接沿用。

### 5.3 只想先停用插件

从 `plugins` 数组中移除本条配置并重启。`~/.config/opencode/memory/` 不会被删除，随时可以再装回来。

### 5.4 恢复备份

```bash
rm -rf ~/.config/opencode/memory
mv ~/.config/opencode/memory.bak-YYYY-MM-DD ~/.config/opencode/memory
```

## 6. 常见失败

| 症状                                                     | 原因                        | 处理                                                           |
| -------------------------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| V2 里插件完全不生效，没有任何报错                        | 装了 `latest`（1.2.x）      | 改成 `@devcxl/opencode-memory@v2` 或精确 `2.0.0`               |
| `opencode plugin list` 显示 `1.2.x`                      | 同上，或对象形式没写版本    | 在 `package` 字段写 `@v2`，再执行 `opencode plugin add` 或重启 |
| 改了包名仍然不加载                                       | 还在用 `plugin` 键          | 改成 `plugins`（复数）                                         |
| 启动/加载时报 "Remote mode is no longer supported"       | 配置或环境变量里仍有 remote | 删除 `mode: "remote"`、`remote` 块、`OPM_MODE` 等              |
| `search` 报找不到 `vectra` / `@huggingface/transformers` | 安装时省略了可选依赖        | 重新安装，不要用 `--omit=optional`，也不要 `--no-optional`     |
| `search` 报模型缓存损坏                                  | 模型下载不完整              | 清理插件目录下 `@huggingface/transformers/.cache` 后重试       |
| 两个项目互相看到对方的项目记忆                           | 项目检测失败后降级为全局    | 确认 session 所在目录是 git 仓库；必要时显式用 `--scope`       |
| 插件版本与 OpenCode 不匹配                               | CLI 低于 2.3.x              | 升级 OpenCode 到 2.3.x                                         |
| macOS / Windows 上行为异常                               | 两平台未验证                | 记录复现步骤并反馈；生产环境优先 Linux                         |

## 7. 支持边界

- **承诺**：OpenCode 2.3.x + Linux 的本地模式；V1 线（`1.2.x`）只做安全与数据损坏修复。
- **不承诺**：OpenCode 2.0.x–2.2.x；macOS / Windows；远程模式；V1/V2 双入口；上下文缓存。

---

## English: Migration guide (V1 → V2)

> Applies to `@devcxl/opencode-memory` 1.2.x → 2.0.x. 2.0.0 is an **OpenCode V2-only,
> local-only** release: V1 plugins do not load in OpenCode V2, and the V2 plugin cannot run
> on OpenCode V1.

Package overview and install entry points: [README.md](../README.md) · [README.zh.md](../README.zh.md)

### 1. Decide which line you need

| Runtime              | Install spec                                      | Resolved version   | Config key |
| -------------------- | ------------------------------------------------- | ------------------ | ---------- |
| OpenCode V1          | `plugin: ["@devcxl/opencode-memory"]`             | `1.2.1` (`latest`) | `plugin`   |
| OpenCode V1 (pinned) | `plugin: ["@devcxl/opencode-memory@1.2.1"]`       | `1.2.1`            | `plugin`   |
| OpenCode V2 RC       | `plugins: ["@devcxl/opencode-memory@2.0.0-rc.1"]` | RC                 | `plugins`  |
| OpenCode V2 stable   | `plugins: ["@devcxl/opencode-memory@v2"]`         | `2.0.x`            | `plugins`  |
| OpenCode V2 (pinned) | `plugins: ["@devcxl/opencode-memory@2.0.0"]`      | `2.0.0`            | `plugins`  |

- **`latest` never moves to 2.x.** Installing `latest` on V2 gives you a plugin that does
  not load.
- Minimum runtime is **OpenCode 2.3.x** (`@opencode/plugin@^2.3.0`).
- Verify registry tags first: `npm view @devcxl/opencode-memory dist-tags`.

### 2. Upgrade steps

1. **Back up the memory directory**: `cp -a ~/.config/opencode/memory ~/.config/opencode/memory.bak-$(date +%F)`.
   V2 reuses the same directory; no file has to be moved or renamed.
   `root.index` / `daily.index` are local vector indexes and can be deleted — they rebuild.
2. **Upgrade OpenCode to 2.3.x** before touching the plugin config.
3. **Rename the config key** `plugin` → `plugins` in `~/.config/opencode/opencode.json` and
   set the spec to `@devcxl/opencode-memory@v2` (or an exact `2.0.0`). `@v2` is a dist-tag,
   so OpenCode checks it for updates; pin an exact version for repeatable installs.
4. **Remove remote settings**: `mode`, `remote`, `apiUrl`, `apiKey`, and the
   `OPM_MODE` / `OPM_API_URL` / `OPM_API_KEY` environment variables.
5. **Restart OpenCode** (or `/reload`), then confirm with the CLI:
   `opencode plugin list` should show `@devcxl/opencode-memory` at version `2.0.x`, not
   `1.2.x`. `opencode plugin check` lists optional update candidates.
6. **Verify the tool and your data**: call the `memory` tool with `action: list`, then
   `action: read`, `target: memory`, then `action: search` with a term you know is stored.
   If `search` complains about a missing module, see section 6.

### 3. Remote mode

Remote memory is gone from this package (no remote provider, Worker, web console or shared
package). It lives in [`@devcxl/cabbage-memory`](https://github.com/devcxl/cabbage-memory).

A config with `mode: "remote"`, a `remote` block, or `OPM_MODE=remote` makes setup throw a
migration error that names `@devcxl/cabbage-memory`. It never silently falls back to local
files. Either switch to `@devcxl/cabbage-memory`, or delete the remote settings to stay
local. Remote data export is out of scope for this package.

### 4. Behavior changes

| Change                | V1                                          | V2                                                                   |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `/memory-init`        | Disappears from the command list when ready | Always registered; returns immediately when memory is ready          |
| Daily-log reminder    | `session.idle` TUI toast                    | `Memory Reminder` section in the next model request's system context |
| Project scope         | Process cwd                                 | Session location; falls back to global when detection fails          |
| Context injection     | Built once at session start                 | Rebuilt from disk before every model request (no cache yet)          |
| Config / plugin shape | `plugin`, V1 plugin API                     | `plugins`, `Plugin.define({ id, setup })`                            |
| Remote mode           | Supported (`mode: "remote"`)                | Removed; throws a migration error                                    |

Rebuilding context on every request means long sessions re-read MEMORY / IDENTITY / USER
each turn. That is a known limitation, not a misconfiguration.

### 5. Downgrade and rollback

- **Inside V2**: pin `2.0.0`, or go back to a previous 2.0.x / RC
  (`"@devcxl/opencode-memory@2.0.0-rc.1"`), then restart. The memory directory stays as is.
- **You cannot downgrade to 1.2.x on V2.** 1.2.x is a V1 plugin and will not load. Returning
  to 1.2.x requires downgrading OpenCode to V1 and switching the config key back to
  `plugin`: `"plugin": ["@devcxl/opencode-memory@1.2.1"]`.
- **Disable without deleting data**: remove the entry from `plugins` and restart; the memory
  directory is untouched.
- **Restore a backup**: `rm -rf ~/.config/opencode/memory` then move the backup back.

### 6. Common failures

| Symptom                                                  | Cause                                             | Fix                                                         |
| -------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Plugin silently does nothing on V2                       | Installed `latest` (1.2.x)                        | Use `@v2` or an exact `2.0.0`                               |
| Still not loading after changing the spec                | Config key is still `plugin`                      | Use `plugins`                                               |
| `opencode plugin list` shows `1.2.x`                     | Installed `latest`, or object form has no version | Put `@v2` in the `package` field, re-add or restart         |
| "Remote mode is no longer supported" at load             | Remote config or env vars remain                  | Delete `mode: "remote"`, `remote`, `OPM_*`                  |
| `search` fails on `vectra` / `@huggingface/transformers` | Optional deps were skipped                        | Reinstall without `--omit=optional`                         |
| `search` reports a corrupted model cache                 | Incomplete model download                         | Remove `@huggingface/transformers/.cache` in the plugin dir |
| Two projects see each other's project memory             | Detection failed and fell back to global          | Run from a git repo, or set `--scope` explicitly            |
| Plugin/CLI mismatch                                      | OpenCode below 2.3.x                              | Upgrade OpenCode to 2.3.x                                   |
| Odd behavior on macOS / Windows                          | Both platforms unverified                         | Report repro steps; prefer Linux for production             |

### 7. Support boundary

- **Promised**: OpenCode 2.3.x + Linux, local mode. The V1 line (`1.2.x`) receives
  security and data-loss fixes only.
- **Not promised**: OpenCode 2.0.x–2.2.x; macOS / Windows; remote mode; a V1/V2 dual-entry
  package; context caching.
