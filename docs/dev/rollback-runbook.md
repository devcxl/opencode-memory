# 回滚 Runbook（2.0.x）

> 适用: `@devcxl/opencode-memory` V2 线 | 更新日期: 2026-11-15
> 前置决策: #12（回滚与事故响应）、#13（迁移与发布说明）

**核心不变式**：`latest` 永远指 V1 线（`1.2.1`），回滚只动 `v2` / `rc`；坏版本只 deprecate，
**绝不 unpublish**；修复用新的 patch 版本，**绝不复用已发布的版本号**。

---

## 1. 严重级别与触发

| 级别 | 触发条件                                                                           | 响应                                                             | 时限                       |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| S1   | 数据丢失/损坏；插件完全无法加载；核心 `memory` 能力不可用且无 workaround；安全漏洞 | 立即回退 `v2` tag + `npm deprecate` 坏版本 + 置顶 incident issue | 24h 内 workaround 或 2.0.1 |
| S2   | 某个核心动作在部分环境失效，但存在 workaround                                      | 不动 tag；7 天内发 2.0.1；若扩散或 7 天未修，升级为 S1           | 7 天                       |
| S3   | 文档、提示、非核心日志/UI 问题                                                     | 不回滚；随下一次 patch 修                                        | 下次发布                   |

- **单一可复现的 S1 报告即可触发**，不需要等到"大量用户"。
- 定级以"能否恢复数据 + 能否继续用"为准，而不是报告数量。
- 所有动作写入 incident issue，不依赖私聊。

## 2. 触发 → 动作 → 负责人 → 验证

| 步骤 | 动作                                          | 负责人 | 验证                                                |
| ---- | --------------------------------------------- | ------ | --------------------------------------------------- |
| 1    | 复现并定级（S1/S2/S3）                        | 维护者 | incident issue 记录复现命令与输出                   |
| 2    | 冻结新发布（暂停 Release / tag）              | 维护者 | 无进行中的 draft release                            |
| 3    | 开并置顶 incident issue                       | 维护者 | issue 含影响范围、workaround、目标修复版本          |
| 4    | 回退 `v2`（或移除 `v2`）                      | 维护者 | `npm view ... dist-tags` 中 `v2` 指向预期版本       |
| 5    | `npm deprecate` 坏版本                        | 维护者 | `npm view @devcxl/opencode-memory@<bad> deprecated` |
| 6    | 更新 GitHub Release 说明（顶部加 Do not use） | 维护者 | Release 页面出现警告与 workaround                   |
| 7    | 更新 README / 迁移指南中的已知问题            | 维护者 | 文档与 issue 描述一致                               |
| 8    | 发布修复 patch（2.0.1），回指 `v2`            | 维护者 | 新版本可安装、`dist-tags` 正确                      |
| 9    | 关闭 incident，记录根因与防再发措施           | 维护者 | issue 有"根因 / 检测 / 防再发"三段                  |

---

## 3. npm 侧动作（按顺序执行）

### 3.1 有上一个可用的 V2 版本（2.0.1 之后最常见）

```bash
# 1) 把 v2 指回上一个可用版本
npm dist-tag add @devcxl/opencode-memory@<last-good-v2> v2

# 2) 标记坏版本，不删除
npm deprecate "@devcxl/opencode-memory@<bad-version>" \
  "Do not use; see <incident issue URL>. Pin <last-good-v2> or wait for <next-version>."

# 3) 校验
npm view @devcxl/opencode-memory dist-tags --json
npm view "@devcxl/opencode-memory@<bad-version>" deprecated
```

### 3.2 没有上一个可用的 V2（`2.0.0` 是首个 V2 时）

```bash
# 移除 v2，让用户只能精确 pin（并回退到 RC 或等待修复）
npm dist-tag rm @devcxl/opencode-memory v2

npm deprecate "@devcxl/opencode-memory@2.0.0" \
  "Do not use; see <incident issue URL>. Use @rc or wait for 2.0.1."

npm view @devcxl/opencode-memory dist-tags --json
```

### 3.3 RC 出问题

```bash
# 指回上一个 RC，或直接移除 rc
npm dist-tag add @devcxl/opencode-memory@<last-good-rc> rc
# 或
npm dist-tag rm @devcxl/opencode-memory rc

npm deprecate "@devcxl/opencode-memory@<bad-rc>" "Pre-release withdrawn; see <issue URL>."
```

RC 修复后发 `rc.2`，观察窗口从 `rc.2` 重新计时。

### 3.4 绝对不做的事

- **不 `npm unpublish`**。版本号不可复用，unpublish 会破坏 lockfile 与审计记录。
  唯一例外是恶意代码/安全事件导致必须下线，此时按 npm 安全流程单独评估并记录。
- **不动 `latest`**。`latest` 必须始终等于 V1 线的最新版本（当前 `1.2.1`）。
  任何让它指向 2.x 的操作都是严重事故。
- **不重发同版本号**。修复一律新 patch。

### 3.5 发布后校验（每次 tag 变动后）

```bash
npm view @devcxl/opencode-memory dist-tags --json
# 期望形状：latest = 1.2.x；v2 = 最新可用 2.0.x（回滚期间可能是旧版本或不存在）；rc = 当前预发布或不存在
```

`latest` 若不再是 `1.2.x`，立即按 S1 处理并恢复。

---

## 4. GitHub 侧动作

| 动作                | 做法                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Release 说明加警告  | 编辑对应 Release，顶部插入 `> **Known issue / Do not use** …` 与 workaround、目标修复版本 |
| 让 "Latest" 回到 V1 | 严重时可把 2.0.x Release 勾选为 prerelease（V2 用户仍可装 `@v2`/精确版本）                |
| 事故可见性          | 新建并 pin incident issue，标题带 `S1`/`S2` 与版本号                                      |
| 保留记录            | 不删除 tag 与 Release；版本与 tag 必须可追溯                                              |
| 关闭                | 修复发布并验证后关闭 incident，补根因与防再发措施                                         |

注意：勾选 prerelease 只影响 GitHub 的 "Latest" 展示，**不改变 npm dist-tag**，两者要分别处理。

---

## 5. 用户侧 workaround（写进 Release 说明与 incident issue）

V2 用户（OpenCode 2.3.x）按优先级：

1. 有上一个可用 V2：`plugins: ["@devcxl/opencode-memory@<last-good-v2>"]`
2. 没有可用稳定版：`plugins: ["@devcxl/opencode-memory@2.0.0-rc.1"]`（若 RC 可用）
3. 都不可用：从 `plugins` 中移除本条并重启，**保留** `~/.config/opencode/memory/`，等待修复版本

V1 用户：不受影响，继续 `latest` / `1.2.1`。

**不要**建议用户回退到 1.2.x 来"修复"V2 问题：1.2.x 在 V2 里根本不会加载，会让用户误以为插件坏了；
回到 V1 必须连 OpenCode 一起降级。

数据安全提示：出问题期间不要删除 `~/.config/opencode/memory/`；`root.index` / `daily.index`
是可重建的派生数据，删了也不丢记忆。

---

## 6. 恢复路径（2.0.1）

1. 在 `main` 上修复并补回归测试（覆盖触发事故的 seam）。
2. `apps/plugin/package.json` bump 到 `2.0.1`（根包版本同步）。
3. 走正常 Release 流程创建 tag `v2.0.1`；dist-tag 由 `distTag.ts` 推导为 `v2`。
4. 发布后：

```bash
npm view @devcxl/opencode-memory dist-tags --json   # v2 应为 2.0.1
npm view @devcxl/opencode-memory@2.0.1 version
```

5. 解除旧版本 deprecate（如适用）：

```bash
npm deprecate "@devcxl/opencode-memory@<bad-version>" ""
```

6. 更新 Release 说明、README、迁移指南中的"已知问题"段落。
7. 在 incident issue 记录根因、检测方式、防再发措施，然后关闭。

---

## 7. RC 阶段演练（不碰生产）

RC 验收必须包含降级演练，但**不要求真的回滚生产 `v2`**（此时还没有稳定版）：

1. 用 `@rc` 安装 `2.0.0-rc.1`，确认插件 active、`memory` 工具可用。
2. 配置改成精确 `2.0.0-rc.1`，重启，确认仍可用。
3. 在本地 Verdaccio（或一次性测试包）上演练：`dist-tag add` / `dist-tag rm` / `deprecate` 三步。
4. 确认 V1 用户视角不变：`latest` 仍解析到 `1.2.1`。
5. 记录演练命令与结果，附在 RC 验收清单里。

演练只验证"命令与顺序正确"，不验证"npm 生产状态"。

---

## 8. 快速决策表

| 现象                                         | 级别 | 首动作                                    |
| -------------------------------------------- | ---- | ----------------------------------------- |
| 用户记忆文件被覆盖/丢失                      | S1   | 回退 `v2`、deprecate、冻结发布            |
| 插件在任何 V2 环境都不加载                   | S1   | 回退 `v2`（无旧版则移除 `v2`）、deprecate |
| `memory` 工具完全不可用且无 workaround       | S1   | 同上                                      |
| 安全漏洞                                     | S1   | 回退 + deprecate + 评估是否必须下线       |
| `search` 在部分环境失败，`read`/`write` 正常 | S2   | 记录 issue，7 天内发 2.0.1                |
| `/memory-init` 提示异常但可用                | S3   | 下次 patch 修                             |
| 文档/示例错误                                | S3   | 下次 patch 修                             |
