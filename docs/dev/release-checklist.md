# RC 验收清单与安装 Smoke 指南（2.0.0-rc.1）

> 适用: `@devcxl/opencode-memory` V2 线 RC 验收 | 更新日期: 2026-11-15
> 前置决策: #10（RC 门禁）、#11（验证矩阵）、#12（回滚策略）、#24（本清单）
> 配套文档: [回滚 Runbook](./rollback-runbook.md) · [迁移指南](../migration-v2.md) · [发布说明模板](./release-notes-templates.md) · [本地插件流程](./architecture-flow.md)

**范围**：OpenCode **2.3.0** + **Linux x64** + **local 模式**。macOS / Windows **未验证**，不作为
RC 阻塞项，但必须写进 RC 发布说明。远程模式已不在本包内，`mode: remote` 只用于抛迁移错误。

**与回滚文档的分工**：本清单只判定"这一版能不能发"。发出去之后出事怎么回退（tag 动作、
deprecate、用户 workaround、S1/S2 定级）见 [回滚 Runbook](./rollback-runbook.md)，此处不重复。

---

## 0. 怎么用这份清单

- **一轮 RC 一份记录**：本文件是模板。实际执行时把判定表填好放进 RC issue（#25），不要复制全文，
  也不要另写一份平行清单。
- **二元判定**：每条只有 `PASS` / `FAIL`。没有"基本可用""大部分通过""除某平台外通过"。
  任一预期不满足即 `FAIL`；证据缺失的 `PASS` 按 `FAIL` 处理。
- **执行顺序**：§3 自动化门禁 → §4 安装 smoke → §5 场景清单 → §6 阻塞判定 → §7 归档。
  自动化门禁没过就不要开始手工验收，否则是在给一个注定失败的构建收集证据。
- **两类条目**：`阻塞` 项 FAIL 直接卡 RC；`记录` 项 FAIL 允许带病发布，但必须开 issue 并写进
  RC 发布说明的 Known limitations。
- **耗时基线**：自动化约 10 分钟；手工 5 个环境首次约 2–3 小时（含 embedding 模型下载与两轮会话）。

---

## 1. 环境矩阵

| 环境 | 安装 / 数据来源                                            | HOME 与配置                                           | 覆盖场景    | 阻塞 |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------- | ----------- | ---- |
| E1   | 本地 `npm pack` tarball（`2.0.0-rc.1`）                    | 全新临时 HOME，`plugins` 指向解包出的插件目录         | A B C D F G | 是   |
| E2   | npm registry `@rc`（`@devcxl/opencode-memory@2.0.0-rc.1`） | 全新临时 HOME，`plugins` 写精确版本                   | A F J4-J6   | 是   |
| E3   | 从 `1.2.1` 升级（真实旧安装或旧目录 fixture）              | 临时 HOME 中放入旧 `memory/` 数据，配置改成 `plugins` | H           | 是   |
| E4   | 干净 HOME + 两个 git 项目                                  | `plugins` 指向 E1 的本地插件目录                      | P           | 是   |
| E5   | 干净 HOME + 故障注入                                       | 独立临时 HOME，允许破坏性操作                         | I           | 是   |

平台与工具链（与 CI 一致，避免"本地能跑、CI 红"）：

| 项              | 值 / 状态                                                |
| --------------- | -------------------------------------------------------- |
| 运行平台        | Linux x64 —— **必测**                                    |
| macOS / Windows | **未验证**（不阻塞；发布说明必须保留该披露）             |
| OpenCode        | `2.3.0`（`@opencode/plugin@^2.3.0`；2.0.x–2.2.x 不支持） |
| Node.js         | 24.x                                                     |
| pnpm            | 11.28.4                                                  |
| Bun             | 1.4.4                                                    |
| npm             | 随 Node 24                                               |
| 本地 registry   | 仅 §4.5 降级演练可选（Verdaccio），不碰生产 npm          |

E3 说明：`1.2.1` 是 docs-only 补丁，字段格式与 `1.2.0` 相同。如果手边没有真实的 `1.2.1` 安装，
可以按 V1 目录结构构造 fixture（`MEMORY.md` / `IDENTITY.md` / `USER.md` / `daily/YYYY-MM-DD.md` /
`projects/<owner>/<repo>/`），但**必须在证据里注明是 fixture**，不能当成真实升级验证。

---

## 2. 隔离：干净 HOME 与临时项目

插件只认 `$HOME`：memory 目录是 `$HOME/.config/opencode/memory`，配置是
`$HOME/.config/opencode/opencode.json`（见 `apps/plugin/src/config/runtime.ts`）。所以隔离靠换
`HOME`，不是靠换工作目录。

```bash
# 每个环境一个根目录，互不共享 HOME
export RC_ROOT=/tmp/opm-rc/E1
export HOME="$RC_ROOT/home"
mkdir -p "$HOME/.config/opencode" "$RC_ROOT/evidence"
cd "$RC_ROOT"
```

约定与坑：

- **不要用 `XDG_CONFIG_HOME` 做隔离**：插件不读它，会静默写回真实 `~/.config/opencode/memory`。
- **临时 HOME 没有 OpenCode 认证**：先在**该 HOME 内**完成一次登录（`opencode auth login`
  或你平时用的等价方式）。凭证留在临时 HOME，**不要**复制真实 `~/.config/opencode/memory`，
  否则 B 组"首次运行"用例会直接假通过。
- **临时项目建 git 仓库并加一个假 remote**：项目 ID 优先取 `git remote origin` 解析出的
  `owner/repo`；没有 remote 时降级成 `<目录名>.<路径哈希>`，非 git 目录也一样。两种形态都能用，
  但路径断言不同，验收时统一用 remote 形态：

  ```bash
  mkdir -p "$RC_ROOT/proj-a" && git -C "$RC_ROOT/proj-a" init -q
  git -C "$RC_ROOT/proj-a" remote add origin https://github.com/rc-check/proj-a.git
  ```

  临时 HOME 下的 `~/.config`、`~/.local` 这类以 `.` 开头的目录被视为"非项目"，会强制降级全局
  （P5 就用这个特性测降级）。

- **模型缓存落在临时 HOME**：首次 `search` 会下载 embedding 模型（`~/.cache` 下），E1 会慢一次，
  磁盘占用随之上升。删 `$RC_ROOT` 即回收。
- **隔离生效的判定**：跑完一轮后真实 `~/.config/opencode/memory` 的 `find` 结果没有新文件。
- **收尾**：证据归档后 `rm -rf "$RC_ROOT"`。证据不要留在临时 HOME 里（会被一起删掉）。

---

## 3. 自动化门禁（每次 RC 必跑，先过）

全部在仓库根执行；任何一项 `FAIL` 都停止手工验收。

| ID  | 步骤 / 命令                                                                                                                          | 预期结果                         | 证据                        | PASS 判定                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------- | -------------------------------------------------- |
| G1  | `pnpm typecheck`                                                                                                                     | 无 TS 错误                       | 终端输出                    | 退出码 0                                           |
| G2  | `pnpm --filter @devcxl/opencode-memory test`                                                                                         | `bun test` 全部通过              | 输出末行统计                | `0 fail`，且无 skip 掩盖阻塞用例                   |
| G3  | `pnpm format:check`                                                                                                                  | 无待格式化文件                   | 终端输出                    | 退出码 0                                           |
| G4  | `pnpm --filter @devcxl/opencode-memory build`                                                                                        | 生成 `apps/plugin/dist`          | `ls dist dist/instructions` | `dist/index.js` 与 `dist/instructions/*.md` 都存在 |
| G5  | `cd apps/plugin && npm pack --dry-run --ignore-scripts`                                                                              | 只含 `dist/**` 与 `package.json` | 完整文件清单                | 无 `src/`、`tests/`、`docs/`、`apps/`              |
| G6  | `rg -n "providers/remote\|apps/api\|apps/web\|packages/shared" apps docs README.md README.zh.md -g '!docs/dev/release-checklist.md'` | 无匹配                           | 输出                        | 0 匹配（本清单自身不参与匹配）                     |
| G7  | `bun apps/plugin/src/release/distTagCli.ts 2.0.0-rc.1`                                                                               | 输出 `rc`                        | 输出                        | 完全等于 `rc`                                      |
| G8  | `bun apps/plugin/src/release/distTagCli.ts 2.0.0` / `... 1.2.1`                                                                      | 输出 `v2` / `latest`             | 输出                        | 两个都正确，且 2.x 不出现 `latest`                 |
| G9  | `node -p "require('./package.json').version"` 与 `node -p "require('./apps/plugin/package.json').version"`                           | 两个版本相同                     | 两行输出                    | 相等，且等于本次发布版本                           |

G6 的 `rg` 若命中历史文档（`docs/dev/research/`、`docs/dev/specs/`）里的引用，按"文档引用"处理并
记录，不判 `FAIL`；命中 `apps/plugin/src` 或 `dist` 即 `FAIL`。

---

## 4. 安装 Smoke

两种安装路径**都要跑**，它们失败的原因不同：tarball 排除 registry 变量（解析、optional 依赖、
安装脚本），`@rc` 验证真实的 dist-tag 解析与发布产物。

### 4.1 E1：本地 `npm pack` tarball

```bash
export RC_ROOT=/tmp/opm-rc/E1
export HOME="$RC_ROOT/home"
mkdir -p "$HOME/.config/opencode" "$RC_ROOT/evidence" "$RC_ROOT/plugin"

# 1) 打包（在插件包目录）
cd /path/to/opencode-memory/apps/plugin
npm pack --pack-destination "$RC_ROOT"
TGZ="$RC_ROOT/devcxl-opencode-memory-2.0.0-rc.1.tgz"

# 2) 装到一个临时插件目录（不要装进仓库）
cd "$RC_ROOT/plugin" && npm init -y >/dev/null
npm install "$TGZ" --include=optional
export PLUGIN_DIR="$RC_ROOT/plugin/node_modules/@devcxl/opencode-memory"

# 3) 准备一个带 remote 的临时项目（项目 ID 才会是 owner/repo 形态）
mkdir -p "$RC_ROOT/proj-a" && git -C "$RC_ROOT/proj-a" init -q
git -C "$RC_ROOT/proj-a" remote add origin https://github.com/rc-check/proj-a.git

# 4) 配置指向插件目录
cat > "$HOME/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$PLUGIN_DIR"]
}
EOF
```

V2 的本地插件路径**必须指向目录**（README 已写明）。指向 `.tgz` 文件本身不会加载，也不会报错。

| ID  | 步骤 / 命令                                                                                    | 预期结果                                                                             | 证据         | PASS 判定                  |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------ | -------------------------- |
| S1  | `node -p "require('$PLUGIN_DIR/package.json').version"`                                        | `2.0.0-rc.1`                                                                         | 输出         | 与发布版本完全一致         |
| S2  | `opencode plugin list`                                                                         | 出现 `@devcxl/opencode-memory`，版本 `2.0.0-rc.1`                                    | 输出（脱敏） | 出现且版本一致             |
| S3  | `ls -d "$PLUGIN_DIR/node_modules/vectra" "$PLUGIN_DIR/node_modules/@huggingface/transformers"` | 两个目录都存在                                                                       | 输出         | 两个都存在                 |
| S4  | 在 `$RC_ROOT/proj-a` 启动 OpenCode，调用 `tools.memory({ action: "list" })`                    | 返回结构化 content，无 error                                                         | 工具返回原文 | 有 content 且不含 `Error:` |
| S5  | 同一次启动的日志（`OPM_DEBUG=1`）                                                              | 无 `Missing required optional dependencies`、无 `Remote mode is no longer supported` | 日志片段     | 两条都不出现               |

### 4.2 E2：发布后 `@rc` 安装

```bash
export RC_ROOT=/tmp/opm-rc/E2
export HOME="$RC_ROOT/home"
mkdir -p "$HOME/.config/opencode" "$RC_ROOT/evidence"
cat > "$HOME/.config/opencode/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@devcxl/opencode-memory@2.0.0-rc.1"]
}
EOF

# 若本机 OpenCode 有 plugin add，可用它代替手写配置（二选一）
# opencode plugin add @devcxl/opencode-memory@2.0.0-rc.1
# 之后确认配置里只有一条本插件的条目，避免重复注册
```

RC 阶段配置**写精确版本**，不写 `@rc`：验收要能复现到具体构建，`@rc` 会在 rc.2 发布后静默漂移。
`$TGZ` 沿用 §4.1 的变量；在同一个 shell 里顺序执行两节即可。

| ID  | 步骤 / 命令                                                                                  | 预期结果                                     | 证据          | PASS 判定                                     |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------- | --------------------------------------------- |
| S6  | `opencode plugin list`                                                                       | 出现该包，版本 `2.0.0-rc.1`（来自 registry） | 输出（脱敏）  | 出现且版本一致                                |
| S7  | `npm view @devcxl/opencode-memory@2.0.0-rc.1 dist.tarball`                                   | 返回 registry 上的 tarball URL               | 输出          | URL 指向 rc 版本                              |
| S8  | 同 S4 的 `tools.memory({ action: "list" })`                                                  | 返回结构化 content                           | 返回原文      | 有 content 且不含 `Error:`                    |
| S9  | 包内容与 E1 tarball 对比：`tar -tzf "$TGZ" \| sort` 对 `tar -tzf <registry tarball> \| sort` | 文件清单一致                                 | 两份清单 diff | 清单一致（字节级 sha1 差异只记录，不判 FAIL） |

### 4.3 发布后 registry 校验（dist-tags）

```bash
npm view @devcxl/opencode-memory dist-tags --json | tee "$RC_ROOT/evidence/dist-tags.json"

# 用仓库里的唯一实现校验，避免手工比对漏项
bun apps/plugin/src/release/verifyDistTagsCli.ts 2.0.0-rc.1 rc "$RC_ROOT/evidence/dist-tags.json"
```

期望快照（RC 阶段）：

```json
{ "latest": "1.2.1", "rc": "2.0.0-rc.1" }
```

| ID  | 检查点              | 预期                                       | 证据           | PASS 判定                                         |
| --- | ------------------- | ------------------------------------------ | -------------- | ------------------------------------------------- |
| S10 | `latest`            | `1.2.1`（V1 线）                           | dist-tags.json | 严格等于 `1.2.1`；出现 2.x 即 S1，按 runbook 处理 |
| S11 | `rc`                | `2.0.0-rc.1`                               | dist-tags.json | 严格等于本次 RC 版本                              |
| S12 | `v2`                | 不存在（首个稳定版之前不设置）             | dist-tags.json | `v2` 缺失，或存在但指向 2.x 稳定版                |
| S13 | `verifyDistTagsCli` | 打印 `✓ dist-tags 校验通过：rc=2.0.0-rc.1` | 输出           | 退出码 0                                          |

### 4.4 E1 与 E2 的分工（失败时怎么定位）

| 现象                         | 指向                                          |
| ---------------------------- | --------------------------------------------- |
| E1 FAIL、E2 PASS             | 打包内容或本地依赖解析问题（`files`、`dist`） |
| E1 PASS、E2 FAIL             | 发布产物、dist-tag 或 registry 传播问题       |
| 两者都 FAIL、自动化门禁 PASS | OpenCode 侧加载/运行时问题（版本、配置形状）  |

### 4.5 降级演练（RC 必做一次）

1. 用 E2 的 HOME，配置改成精确 `2.0.0-rc.1`（已是精确版本则跳过），重启 OpenCode，确认仍可用。
2. 在本地 Verdaccio 或一次性测试包上演练 `dist-tag add` / `dist-tag rm` / `deprecate` 三步，
   确认命令与顺序正确（**不碰生产 npm**）。
3. 确认 V1 视角不变：`npm view @devcxl/opencode-memory dist-tags` 里 `latest` 仍是 `1.2.1`。

| ID  | 步骤                                             | 预期结果                                          | 证据        | PASS 判定                     |
| --- | ------------------------------------------------ | ------------------------------------------------- | ----------- | ----------------------------- |
| S14 | 配置精确 `2.0.0-rc.1` 后重启                       | 插件仍加载，`M(list)` 可用                        | 输出        | 加载成功且工具可用            |
| S15 | 本地 registry 上演练 `dist-tag add` / `rm` / `deprecate` | 三步都成功，tag 指向随命令变化，版本内容不变 | 命令输出    | 三步无报错且指向符合预期      |

命令与判据见 [回滚 Runbook §7](./rollback-runbook.md#7-rc-阶段演练不碰生产)。
演练只验证"命令与顺序正确"，不验证生产 registry 状态。

---

## 5. 场景清单

标记约定：`M({...})` 表示让 agent 调用 `memory` 工具（Code Mode 写 `tools.memory({...})`）；
`CTX` 表示某次模型请求的 system context（前端展开或 `OPM_DEBUG=1` 日志）；
`$MEM` = `$HOME/.config/opencode/memory`。所有条目默认在 E1 执行，另有标注的除外。

**除显式标注 `记录` 的条目外，本节所有条目都是 `阻塞`。** 多项目章节条目用 `P` 前缀，
避免与环境编号 E1–E5 混淆。

### A. 安装与加载

| ID  | 步骤 / 命令                                                                                    | 预期结果                                          | 证据            | PASS 判定                   |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------- | --------------------------- |
| A1  | `rg -n "providers/remote\|apps/api\|apps/web\|packages/shared" "$PLUGIN_DIR"`                  | 无匹配（插件目录里只有 `dist` 与 `package.json`） | 输出            | 0 匹配                      |
| A2  | `opencode plugin list`                                                                         | 出现 `@devcxl/opencode-memory`，版本正确          | 输出            | 出现且版本 == 本次发布版本  |
| A3  | 启动会话，`M({ action: "list" })`；查看命令列表                                                | 工具可用；`/memory-init` 在命令列表里             | 返回 + 命令列表 | 两者都存在                  |
| A4  | `ls -d "$PLUGIN_DIR/node_modules/vectra" "$PLUGIN_DIR/node_modules/@huggingface/transformers"` | 两个可选依赖都在                                  | 输出            | 两个都存在（缺失场景见 I1） |
| A5  | 启动日志（`OPM_DEBUG=1`）                                                                      | 无插件加载错误、无 `Cannot find module`           | 日志片段        | 两条都不出现                |

### B. 首次运行与 `/memory-init`

在 E1 的**全新 HOME** 上跑（`$MEM` 一开始不存在）。

| ID  | 步骤 / 命令                                                                                                                       | 预期结果                                                                                             | 证据                         | PASS 判定                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| B1  | `ls "$MEM"`；`M({ action: "list" })`                                                                                              | 目录不存在或为空；`list` 返回空结果而不是异常                                                        | `ls` 输出 + 返回             | 无模板文件、无异常                                                                  |
| B2  | 执行 `/memory-init`                                                                                                               | 创建 `BOOTSTRAP.md` / `MEMORY.md` / `IDENTITY.md` / `USER.md`，并发出引导 prompt                     | `ls -l "$MEM"` + prompt 文本 | 四个文件都存在，且 prompt 以 `You are initializing the OpenCode memory system` 开头 |
| B3  | 引导阶段发一次请求，看 `CTX`                                                                                                      | 只展示 `## BOOTSTRAP.md (First Run Setup)`，不混入常规记忆                                           | CTX 片段                     | 含 bootstrap 段，且不含 `## MEMORY.md`                                              |
| B4  | 填写 `MEMORY.md` / `IDENTITY.md` / `USER.md`（非模板内容）并 `rm "$MEM/BOOTSTRAP.md"`，再发请求                                   | `CTX` 变成 `# Memory Context` + `## MEMORY.md` / `## IDENTITY.md` / `## USER.md`，不再出现 bootstrap | CTX 片段                     | 段落符合，且无 bootstrap 段                                                         |
| B5  | `sha1sum "$MEM"/*.md > /tmp/before`；再执行一次 `/memory-init`；`sha1sum "$MEM"/*.md > /tmp/after`；`diff /tmp/before /tmp/after` | 文件内容与数量不变，不发引导 prompt                                                                  | 两份 sha1 + diff             | diff 为空，且无新 prompt                                                            |

### C. context 注入

| ID  | 步骤 / 命令                                    | 预期结果                                                                                                           | 证据            | PASS 判定                           |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------- | ----------------------------------- |
| C1  | 在已 ready 的 HOME 发一次请求，看 `CTX`        | 含 `# Memory Context`，并有 `## MEMORY.md` / `## IDENTITY.md` / `## USER.md`                                       | CTX 片段        | 四个段落齐全                        |
| C2  | 不动任何文件，同一会话连发两次请求，对比 `CTX` | 两次完全一致，且不含当天日期（无 `2026-11-15` 之类动态串）                                                         | 两份 CTX + diff | diff 为空，且无日期串               |
| C3  | 在 proj-a 与 proj-b 各发一次请求，对比 `CTX`   | 各自只含本项目记忆段，互不出现对方内容                                                                             | 两份 CTX        | 无交叉（交叉即 FAIL，见 P2）        |
| C4  | 检查 `CTX` 的注入指令段                        | 含 `## Memory` 指令，明确 daily 未注入需显式读取，动作列表与工具 schema 一致（read/write/edit/delete/search/list） | CTX 片段        | 六动作齐全，且写明 daily 需显式读取 |

### D. `memory` 六动作

| ID  | 步骤 / 命令                                                                                                      | 预期结果                                                                                               | 证据                 | PASS 判定                                         |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------- |
| D1  | `M({ action: "read", target: "memory" })`，其余 target 同法                                                      | memory / identity / user / daily 都返回内容；不存在的 daily 返回 `<scopeTag> <文件名> not found or empty.` | 四次返回             | 四个 target 都有可理解结果，无原始异常            |
| D2  | 连续两次 `M({ action: "write", target: "memory", content: "..." })`                                              | 默认追加，文件出现两条带时间戳的条目                                                                   | 文件内容             | 两条都在，且各有时间戳                            |
| D3  | `M({ action: "write", target: "memory", content: "only", mode: "overwrite" })`                                   | 文件只剩新内容                                                                                         | 文件内容             | 旧条目全部消失且文件完整                          |
| D4  | `M({ action: "write", target: "daily", content: "..." })`，再指定 `date: "2026-11-14"`                           | 默认写到当天 `daily/YYYY-MM-DD.md`；显式 date 写到指定日期                                             | `ls "$MEM/daily"`    | 两个文件都存在且内容对应                          |
| D5  | `M({ action: "write", target: "memory", scope: "project", content: "..." })`；再写 `scope: "global"`             | 项目写入 `$MEM/projects/<owner>/<repo>/MEMORY.md`；全局写根 `MEMORY.md`                                | 两处文件内容         | 路径与内容都正确（项目未检测到时应落全局，见 P5） |
| D6  | `M({ action: "edit", target: "memory", oldString: "<存在的片段>", newString: "..." })`；再用不存在的 `oldString` | 第一次替换成功；第二次返回错误且文件不变                                                               | 两次返回 + 文件 sha1 | 首次成功；失败那次报错且 sha1 不变                |
| D7  | 先 `read` 取一条时间戳，`M({ action: "delete", target: "daily", timestamp: "<ts>" })`                            | 该条被删除，同文件其他条目保留                                                                         | 删除前后文件内容     | 只少一条，其余完整                                |
| D8  | `M({ action: "search", query: "<确定存在的关键词>" })`；加 `period: "YYYY-MM"`                                   | 返回结果、相关度分数、时间戳；period 过滤生效                                                          | 返回原文             | 有结果含分数与时间戳，且 period 外的条目不出现    |
| D9  | `M({ action: "list" })`；`M({ action: "list", period: "YYYY-MM" })`；在空 HOME 上再跑一次                        | 概览按月分组；period 返回明细；空目录返回空结果或 `No daily logs found ...`                            | 三次返回             | 三种形态都对，空目录不抛异常                      |

D8 首次调用会下载 embedding 模型，先做一次 warmup 再计时；warmup 失败即视为依赖或网络问题，单独记录。

### E. 多项目 / 多 session（E4）

| ID  | 步骤 / 命令                                                      | 预期结果                                                            | 证据                   | PASS 判定                                |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------- | ---------------------------------------- |
| P1  | proj-a 的 session 写 project memory 与 daily；proj-b 同样操作    | 分别落在 `projects/rc-check/proj-a/` 与 `projects/rc-check/proj-b/` | `find "$MEM/projects"` | 两个项目目录各自独立且内容正确           |
| P2  | proj-a 的 session 发请求 + `search --scope project`              | 看不到 proj-b 的任何内容                                            | CTX + 搜索返回         | 0 处交叉（交叉即 FAIL）                  |
| P3  | 删除 proj-a 的 session，再在 proj-b 发请求                       | proj-b 正常；无残留提醒、无旧项目上下文                             | 请求结果               | proj-b CTX 不含 proj-a 内容与提醒        |
| P4  | 同一项目开两个 session，各自写 project memory + daily            | project memory 共享；daily 按日期一致                               | 文件内容               | 两份写入都可见，日期正确                 |
| P5  | 在 `$HOME` 自身（被排除的路径）开 session，写 `scope: "project"` | 降级写全局根 `MEMORY.md`，不报错崩溃                                | 日志 + 文件            | 写入成功且落在根 `MEMORY.md`，无错误输出 |

### F. Code Mode 与工具调用路径

| ID  | 步骤 / 命令                                                          | 预期结果                                                        | 证据     | PASS 判定                          |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------- | -------- | ---------------------------------- |
| F1  | Code Mode 里执行 `tools.memory({ action: "list" })`                  | 返回结构化 `content`                                            | 执行输出 | 有 content 且非空                  |
| F2  | `记录` 直接工具调用（模型/配置支持时）                               | 工具名 `memory`，参数 schema 正常；非法 `action` 被 schema 拒绝 | 调用记录 | 工具可见，非法参数在 schema 层被拒 |
| F3  | 同一会话先触发一次失败调用（如 D6 的 `oldString` 不匹配），再 `list` | 会话不中断，后续调用正常                                        | 两次返回 | 失败一次后仍能成功调用             |

### G. Daily reminder 与会话生命周期

| ID  | 步骤 / 命令                                                          | 预期结果                                                               | 证据            | PASS 判定                         |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------- | --------------------------------- |
| G1  | 写一次 `memory`（非 daily），再发一次请求                            | `CTX` 出现 `## Memory Reminder` 段，提示调用 `write` + `target: daily` | CTX 片段        | 提醒段出现且文案匹配              |
| G2  | 写 daily 后再发一次请求                                              | 提醒消失                                                               | CTX 片段        | 不再出现 `## Memory Reminder`     |
| G3  | 删除该 session，新建 session 发请求                                  | 新 session 无提醒、无旧状态                                            | 请求结果        | 无提醒                            |
| G4  | 完全退出并重启 OpenCode（有 `service restart` 子命令也可用），再发请求与 `M(list)` | 工具仍注册、命令仍在，`CTX` 只出现一次 Memory 段，无重复订阅迹象 | 请求结果 + 日志 | 工具可用且无重复段落/重复注册日志 |
| G5  | `记录` 长会话：连续 100+ 次 `M(list)`                                | 不崩溃、内存不持续增长（观察 RSS 量级）                                | 进程 RSS        | 无崩溃；增长幅度可解释            |

### H. 从 `1.2.1` 迁移（E3）

| ID  | 步骤 / 命令                                                                 | 预期结果                                                                                                                 | 证据                 | PASS 判定                             |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------- |
| H1  | 把旧配置 `plugin: [...]` 改成 `plugins: [...]`（写精确 `2.0.0-rc.1`），重启 | 插件加载，`opencode plugin list` 显示 2.0.0-rc.1                                                                         | 配置 + 输出          | 加载成功且版本正确                    |
| H2  | `M({ action: "list" })` → `read memory/identity/user` → `search` 旧关键词   | 旧 `MEMORY` / `IDENTITY` / `USER` / `daily` / `projects` 全部可读，搜索命中旧内容                                        | 三次返回             | 旧数据完整可读，搜索有结果            |
| H3  | 在配置里加 `options: { "mode": "remote" }`（或 `OPM_MODE=remote`），启动    | setup 抛迁移错误，含 `Remote mode is no longer supported in this package.` 与 `@devcxl/cabbage-memory`；**不**回退 local | 启动日志             | 报错文本匹配，且无本地写入发生        |
| H4  | 在上述配置里补 `apiUrl` / `apiKey`，再次启动                                | 除同一条迁移错误外无其他副作用：无网络请求、无新文件                                                                     | 日志 + `find "$MEM"` | 错误一致，`$MEM` 无新增               |
| H5  | `记录` 把配置改成 `@1.2.1` 在 V2 下启动                                     | 插件不加载（无工具、无命令），不报本地数据错误                                                                           | 输出                 | 与发布说明口径一致（V2 不能用 1.2.x） |

### I. 失败路径（E5）

| ID  | 步骤 / 命令                                                                | 预期结果                                                                                                                                                             | 证据                  | PASS 判定                                                   |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| I1  | `npm install "$TGZ" --omit=optional` 后启动                                | setup 抛 `Missing required optional dependencies: vectra, @huggingface/transformers`，含 `--omit=optional` 修复建议；**不含** `Cannot find module`；搜索不被静默禁用 | 启动日志              | 三段都满足（依赖名齐、含修复建议、无 `Cannot find module`） |
| I2  | 触发非法 `action` / `target` / `scope`（如 `M({ action: "bogus" })`）      | 返回明确错误并列出合法值（如 `Invalid action: ... Must be one of: ...`），会话不中断                                                                                 | 返回原文              | 三类都报可理解错误，且后续调用仍可用                        |
| I3  | 写 >100KB content；再把 `MEMORY.md` 撑到 >1000 行后写一次                  | 两次都被拒绝并提示上限（`Content exceeds 102400 bytes` / `MEMORY.md exceeds 1000 line limit`），文件不被破坏                                                         | 返回 + 文件 sha1      | 两次拒绝生效，sha1 不变                                     |
| I4  | `chmod 500 "$MEM"` 后写一次（测完 `chmod 700` 还原）                       | 写入失败并给出权限相关错误；无半写文件                                                                                                                               | 返回 + `ls -a "$MEM"` | 报错含权限原因，且无 `*.tmp.*` 残留                         |
| I5  | 往 `$MEM/root.index` 写入垃圾字节，再 `search` 一次，随后 `read` / `write` | 搜索自行重建或给出可修复错误；`read` / `write` 不受影响                                                                                                              | 三次返回 + 日志       | 基本读写正常，且搜索不是崩溃退出                            |
| I6  | `记录` 模型缓存损坏（清空或截断 `@huggingface/transformers` 缓存）         | 报可修复错误，重下后恢复                                                                                                                                             | 日志 + 重试结果       | 错误可理解，重试成功                                        |

I1 需要一份干净 HOME（E5 独立目录），不要复用 E1 的插件目录，否则依赖仍在，测不出来。

### J. 包与 registry 卫生

| ID  | 步骤 / 命令                                                                                                  | 预期结果                                                                                    | 证据           | PASS 判定                                  |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| J1  | G5 的 `npm pack --dry-run` 输出                                                                              | 只有 `dist/**` 与 `package.json`                                                            | 文件清单       | 无 `src`/`tests`/`docs`/`apps`/远程残留    |
| J2  | 根与包版本：G9                                                                                               | 两者都等于 `2.0.0-rc.1`                                                                     | 两行输出       | 相等且等于发布版本                         |
| J3  | `rg -n "opencode-memory@latest\|npm i @devcxl/opencode-memory[^@]" README.md README.zh.md docs`              | 没有把 `latest` 当成 V2 安装方式的说法                                                      | 输出           | 0 匹配                                     |
| J4  | `记录` rc 版本页有没有安装指引：`tar -tzf <registry tarball> \| rg -n "README"`                          | tarball 内含 `README.md`                                                                    | tarball 清单   | 含 `README.md`；缺失时开 S3 issue 并记录   |
| J5  | §4.3 dist-tags                                                                                               | `latest=1.2.1`、`rc=2.0.0-rc.1`                                                             | dist-tags.json | 严格匹配                                   |
| J6  | GitHub Release：tag `v2.0.0-rc.1`、勾选 prerelease、正文用模板                                               | tag 与包版本一致；是 prerelease；正文含 `@2.0.0-rc.1` 或 `@rc`，且写明 macOS/Windows 未验证 | Release 链接   | 三项都满足                                 |
| J7  | `记录` provenance：`npm view @devcxl/opencode-memory@2.0.0-rc.1 dist.attestations` 或 `npm audit signatures` | 有 attestations，或发布说明里写明未启用                                                     | 输出 + 说明    | 二者之一成立即可                           |
| J8  | 默认 npm 页面（`latest` = 1.2.x）仍指向 V2 安装写法：`npm view @devcxl/opencode-memory readme \| rg -n "opencode-memory@v2\|plugins"` | 命中 V1/V2 分流说明，且不含"latest 即 V2"的表述 | 输出 | 命中 `@v2` 或 `plugins`，且无 `latest` 指向 V2 的说法 |

J4 已知情况：仓库包目录 `apps/plugin` 没有 `README.md`，npm 只会收录包根目录的 README（已用
`npm pack --dry-run` 确认 tarball 里只有 `package.json` 与 `dist/**`）。这不影响 J8 的默认页面
（`latest` = 1.2.x 自带 README），只是 rc 版本页缺少安装指引，按 S3 记录。

---

## 6. RC 阻塞判定

**可以发布**，当且仅当：

1. §3 全部 `PASS`。
2. §5 中所有 `阻塞` 条目 `PASS`；所有 `记录` 条目已归档结论（`PASS`，或已开 issue 并写进发布说明）。
3. §4.1 / §4.2 两个安装 smoke 的阻塞项 `PASS`（`S1`–`S8`），`S9` 的差异已记录。
4. §4.3 dist-tags 严格为 `latest=1.2.1`、`rc=2.0.0-rc.1`。
5. 无 open 的 S1 / S2（定级见 [回滚 Runbook §1](./rollback-runbook.md#1-严重级别与触发)）。

以下任一情形**直接阻塞**，不需要讨论"影响面大小"：

- 任何数据丢失或记忆文件损坏。
- 插件在 Linux + OpenCode 2.3.0 上加载失败，或 `memory` 工具完全不可用。
- `mode: remote` 静默回退 local（必须报迁移错误）。
- 可选依赖缺失时静默禁用搜索，或只抛原始 `Cannot find module`。
- `latest` 不等于 `1.2.1`（按 S1 处理，见回滚 Runbook）。
- 多项目之间能看到对方的项目记忆。
- 包内出现远程代码（`providers/remote`、`apps/api`、`apps/web`、`packages/shared`）。

**默认 npm 页面（J8）判为阻塞**：用户故事 6 与 #10 的门禁要求"npm 落地页指向 `@v2`"。默认页面
跟随 `latest`（1.2.x）的 README，必须能看到 V1/V2 分流与 `@v2` 写法。若默认页面又把 `latest`
说成 V2，等于把 V2 用户送上装不上的版本。

**rc 版本页缺 README（J4）判为记录（S3）**：包目录没有 `README.md`，rc 版本页只剩 description。
不影响默认页面，也没有数据风险，开 issue 随下一次 patch 处理（把根 README 复制到 `apps/plugin/`
或写最小安装页，纯文档改动）。

**不阻塞但必须披露**（写进 RC 发布说明的 Known limitations）：

- macOS / Windows 未验证。
- 无上下文缓存，长会话每轮重读记忆文件。
- OpenCode 2.0.x–2.2.x 不支持。
- 无外部 V2 反馈时，稳定版说明按模板写 `No external V2 feedback was received before promotion.`

**FAIL 处理**：在 RC issue 里为每个失败项开独立 issue（环境、条目 ID、命令、期望、实际、
证据链接、S1/S2/S3 级别）。修复后发 `rc.2`，7 天观察窗口从 `rc.2` 重新计时，不能沿用 `rc.1` 的窗口。

---

## 7. 证据归档（RC issue）

证据不进仓库，只在 RC issue（#25）留链接与判定表。

目录约定（每环境一个，与 §1 对齐）：

```text
/tmp/opm-rc/<ENV>/evidence/
  G2-bun-test.log
  S2-plugin-list.txt
  S10-dist-tags.json
  C1-context-ready.md
  I1-omit-optional-setup.log
```

命名 `<条目 ID>-<简述>.<ext>`，与清单 ID 一一对应；截图用 `.png`，文本用 `.txt` / `.log` / `.md`。

RC issue 里贴的表（可直接复制，一行一个条目）：

```md
| 环境 | 条目 | 结论 | 级别 | 证据   | 备注       |
| ---- | ---- | ---- | ---- | ------ | ---------- |
| E1   | S2   | PASS | 阻塞 | <链接> | 2.0.0-rc.1 |
| E5   | I1   | FAIL | 阻塞 | <链接> | issue #NN  |
```

同时记录环境事实，便于日后复现：`opencode --version`、`node -v`、`pnpm -v`、`bun -v`、`git rev-parse HEAD`。

**脱敏**：证据里不要出现 API key、token、真实用户名路径（用 `$HOME` 代替）、记忆文件中的个人信息。
`npm view` 输出、`plugin list` 输出通常安全，日志里可能带上会话内容，贴之前先翻一遍。

**保留期**：至少保留到 `2.0.0` 发布后 7 天（覆盖稳定版观察窗口）。长期证据放 RC issue 附件或仓库外
的私有归档，不要提交进 git。

---

## 附录：期望值速查

判定时对这些字符串/数值做严格比对，不要凭印象。

| 项                   | 期望值                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 远程迁移错误         | `[opencode-memory] Remote mode is no longer supported in this package.` 且含 `@devcxl/cabbage-memory`                                       |
| 可选依赖缺失错误     | `[opencode-memory] Missing required optional dependencies: vectra, @huggingface/transformers`（错误码 `OPM_MISSING_OPTIONAL_DEPENDENCIES`） |
| 可选依赖修复提示     | 含 `--omit=optional` 与 `--include=optional`，且不含 `Cannot find module`                                                                   |
| 引导阶段 context 段  | `## BOOTSTRAP.md (First Run Setup)`                                                                                                         |
| 常规 context 首段    | `# Memory Context`                                                                                                                          |
| daily 提醒段         | `## Memory Reminder`                                                                                                                        |
| 单条内容上限         | 100 KB（102400 字节）                                                                                                                       |
| `MEMORY.md` 行数上限 | 1000 行                                                                                                                                     |
| 临时文件命名         | `<目标文件>.tmp.<时间戳>`（失败后不应残留）                                                                                                 |
| dist-tags（RC）      | `latest=1.2.1`、`rc=2.0.0-rc.1`，无 `v2`                                                                                                    |
| 插件 id              | `devcxl.opencode-memory`                                                                                                                    |
