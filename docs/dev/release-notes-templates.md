# 发布说明模板（1.2.1 / 2.0.0-rc.1 / 2.0.0）

> 适用范围: `@devcxl/opencode-memory` | 更新日期: 2026-11-15

三套模板分别对应 V1 文档补丁、V2 RC 与 V2 稳定版。模板正文用英文（npm 包页面与 GitHub Release
的主要读者），操作说明用中文。模板放在 `~~~` 围栏里，方便整段复制，不会被内部的代码块打断。

## 0. 使用规则（先读）

### 版本 → dist-tag

| 版本形态            | dist-tag | 模板         | 说明                                       |
| ------------------- | -------- | ------------ | ------------------------------------------ |
| `1.2.x`             | `latest` | `1.2.1`      | V1 线，永久占据 `latest`                   |
| `2.0.0-rc.N`        | `rc`     | `2.0.0-rc.1` | 预发布，GitHub Release 必须勾选 prerelease |
| `2.0.x`（含 2.0.0） | `v2`     | `2.0.0`      | 稳定版；`latest` 不动                      |

dist-tag 由 `apps/plugin/src/release/distTag.ts` 推导，workflow 不重复实现规则。

### 硬性约束

- 稳定版说明**必须**写 `plugins: ["@devcxl/opencode-memory@v2"]`。
- **禁止**出现"`latest` 就是 V2"、"`latest` 已升级到 2.x"、"直接 `npm i @devcxl/opencode-memory`
  即可获得 V2"这类表述。`latest` 永远指 V1 线。
- RC 版本必须是精确版本或 `@rc`，不能写 `@v2`。
- 只写已发布事实，不写未来承诺（例如"下个版本支持 macOS"）。

### 发布路径差异

| 版本         | 发布方式                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `1.2.1`      | 从 `v1` 维护分支手动 `npm publish --tag latest`；现有 workflow 要求 tag 提交在默认分支上可达，`v1` 分支不满足 |
| `2.0.0-rc.1` | 走正常 Release 流程（tag `v2.0.0-rc.1`），自动推到 `rc`                                                       |
| `2.0.0`      | 走正常 Release 流程（tag `v2.0.0`），自动推到 `v2`                                                            |

发布后统一校验：

```bash
npm view @devcxl/opencode-memory dist-tags --json
# 期望：latest 始终是 1.2.x；v2 = 最新 2.0.x；rc = 当前预发布
```

---

## 1. 模板：`1.2.1`（V1 docs-only patch）

发布对象：`latest`。代码零改动，只更新 README / package description / version。
GitHub Release 名称：`v1.2.1`，**不要**勾选 prerelease。

```md
## Legacy V1 docs patch (no code changes)

`1.2.1` updates documentation only. There are no code, dependency or behavior changes for
OpenCode V1 users — keep using this package exactly as before.

### Who should use this

- **OpenCode V1**: `plugin: ["@devcxl/opencode-memory"]` (this release, `latest`).
  Pin it with `@1.2.1` for reproducible installs.
- **OpenCode V2 (>= 2.3.x)**: do **not** install `latest`. Use
  `plugins: ["@devcxl/opencode-memory@v2"]` or an exact `2.x` version.
- **Remote memory users**: the remote service moved to
  [`@devcxl/cabbage-memory`](https://github.com/devcxl/cabbage-memory). This package is
  local-only.

### What changed

- README and package description now explain the V1/V2 split and the `plugin` -> `plugins`
  config key change.
- Package version bumped to `1.2.1` so the npm landing page can point V2 users at `@v2`.

### Support

The 1.2.x line receives security and data-loss fixes only. No new features.

Migration guide: https://github.com/devcxl/opencode-memory/blob/main/docs/migration-v2.md
```

---

## 2. 模板：`2.0.0-rc.1`

发布对象：`rc`。GitHub Release 名称：`v2.0.0-rc.1`，**必须**勾选 prerelease，
避免 RC 成为 GitHub "Latest" 发布。

````md
## OpenCode V2 local-only — release candidate

First V2 release of the local-only memory plugin. Pre-release: expect fixes before stable,
and pin the exact version.

### Install

```jsonc
{
  "plugins": ["@devcxl/opencode-memory@2.0.0-rc.1"], // or @rc
}
```

`latest` still points at the V1 line. Do not install `latest` on OpenCode V2.

### Requirements

- OpenCode **2.3.x** (plugin depends on `@opencode/plugin@^2.3.0`)
- Linux is verified. **macOS and Windows are unverified.**
- Optional dependencies `vectra` and `@huggingface/transformers` must be installed
  (semantic `search` needs them; do not use `--omit=optional`).

### Breaking changes

- **Local-only.** Remote mode, the Cloudflare Worker, the web console and the shared
  package are removed from this repository. Remote memory now lives in
  [`@devcxl/cabbage-memory`](https://github.com/devcxl/cabbage-memory); a config with
  `mode: "remote"` throws a migration error and does not fall back to local.
- Config key `plugin` -> `plugins`; package spec must be `@v2` or an exact version.
- `/memory-init` stays registered; running it when memory is ready is a no-op.
- The V1 `session.idle` TUI toast is replaced by a `Memory Reminder` section in the next
  model request's system context.
- Project scope follows the **session location** (was: process cwd).
- Memory context is rebuilt from disk before **every** model request.

### Known limitations

- No context cache: long sessions re-read memory files each turn.
- macOS / Windows unverified.
- OpenCode 2.0.x-2.2.x unsupported.

### Upgrade, downgrade, rollback

- Upgrading from V1: keep `~/.config/opencode/memory/` in place and rename the config key.
- Rollback inside V2: pin a previous `2.x` / RC build and restart.
- **1.2.x cannot run on OpenCode V2.** Returning to the V1 line requires downgrading
  OpenCode to V1 as well.

Migration guide and troubleshooting:
https://github.com/devcxl/opencode-memory/blob/main/docs/migration-v2.md
````

---

## 3. 模板：`2.0.0`（stable）

发布对象：`v2`。GitHub Release 名称：`v2.0.0`，不勾 prerelease。
发布前提：RC 观察窗口（7 天）结束、无未关闭 S1/S2、[RC 验收清单](./release-checklist.md) 全部阻塞项通过。

````md
## OpenCode V2 local-only stable

`2.0.0` is the first stable release of the V2-only, local-only memory plugin.

### Install

```jsonc
{
  "plugins": ["@devcxl/opencode-memory@v2"], // or an exact 2.x version
}
```

**`latest` remains the V1 line (`1.2.x`).** It does not point at V2 and never will during
this release line — OpenCode V1 users are auto-updated from `latest`, and a V2-only package
would not load there. Use `@v2` for the stable V2 line, or pin an exact version.

### Requirements

- OpenCode **2.3.x**
- Linux verified; macOS and Windows unverified
- Keep optional dependencies (`vectra`, `@huggingface/transformers`) installed —
  `--omit=optional` breaks semantic search

### Highlights

- Runs on the OpenCode V2 plugin API (`plugins` config, `@opencode/plugin`).
- Local markdown memory: `MEMORY.md`, `IDENTITY.md`, `USER.md`, daily logs, per-project
  memories.
- `memory` tool actions: read / write / edit / delete / search / list.
- Memory context injected before every model request; `/memory-init` always available for
  recovery.

### Breaking changes

Same as `2.0.0-rc.1`:

- Local-only. Remote mode, Worker, web console and shared package removed; remote memory
  moved to [`@devcxl/cabbage-memory`](https://github.com/devcxl/cabbage-memory).
  `mode: "remote"` now throws a migration error.
- Config key `plugin` -> `plugins`.
- `/memory-init` stays registered (no-op once memory is ready).
- TUI toast replaced by a system-context `Memory Reminder`.
- Project scope follows the session location.
- Context rebuilt before every model request.

### Known limitations

- No context cache.
- macOS / Windows unverified.
- OpenCode 2.0.x-2.2.x unsupported.

### Upgrade / downgrade

- From V1: back up `~/.config/opencode/memory/`, upgrade OpenCode to 2.3.x, rename `plugin`
  to `plugins`, install `@v2`.
- Within V2: pin the previous `2.x` version and restart.
- Back to V1: 1.2.x does not run on OpenCode V2 — downgrade OpenCode to V1 as well.

Migration guide: https://github.com/devcxl/opencode-memory/blob/main/docs/migration-v2.md
Rollback runbook: https://github.com/devcxl/opencode-memory/blob/main/docs/dev/rollback-runbook.md

### Release validation

- RC observation window: 7 days, no open S1/S2.
- Verified on Linux + OpenCode 2.3.x: packed tarball install, published `@v2` install,
  migration from V1, multi-project isolation, failure paths.
- External V2 feedback: <!-- 有反馈时写"Received N reports, summary…"；没有则写 "No external V2 feedback was received before promotion." -->
````

---

## 4. 发布前自检

改完说明后逐条确认：

```bash
# 1. 没有把 latest 说成 V2
rg -n "latest.*(V2|2\.0)|(V2|2\.0).*latest" README.md README.zh.md docs

# 2. 稳定版说明用了 @v2
rg -n "opencode-memory@v2" docs/dev/release-notes-templates.md

# 3. 版本与 tag 一致（workflow 也会校验）
node -p "require('./apps/plugin/package.json').version"

# 4. 发布后 dist-tag 校验
npm view @devcxl/opencode-memory dist-tags --json
```

- [ ] 版本号、GitHub Release tag、npm 包版本三者一致
- [ ] RC 勾选 prerelease；稳定版未勾选
- [ ] 稳定版说明写 `@v2`，且明确"`latest` 仍是 V1"
- [ ] 远程用户被指向 `@devcxl/cabbage-memory`
- [ ] macOS / Windows 未验证的披露保留
- [ ] 迁移指南与回滚 runbook 链接可打开
