# 技术方案：记忆作用域修复

## 概述

修复 `opencode-memory` 插件在项目级记忆与全局记忆之间存在的三层混淆问题：scope 信息不透明（L1）、项目检测脆弱（L2）、daily 日志无项目作用域（L3）。

**原则：最小侵入、向前兼容、优先复用现有架构。**

---

## L1：Scope 透明化

### 问题

当前 handler 返回值不包含 scope 信息，AI 调用 memory 工具后不知道内容写入了哪个 scope（全局还是项目）。例如：

```
Appended to MEMORY.md.        # → 可能是全局，也可能是 projects/xxx/MEMORY.md
```

AI 无法据此做后续判断（如"我刚才写入了项目级，现在需要读项目级"）。

### 方案

在每个 handler 的返回字符串中添加 `[scope: ...]` 标签。

**改动范围：** `src/handlers/handleWrite.ts`, `handleRead.ts`, `handleEdit.ts`, `handleDelete.ts`, `handleSearch.ts`

**关键设计：** handler 本身不计算 scope，由调用方（`src/index.ts` 的 `execute`）传入已解析的 `resolvedProject` 和 `scope`。handler 仅基于 `project` 参数的有无来生成 scope 标签。

### 具体改动

#### 1. `handleWrite.ts`

**当前返回：**
```
Appended to MEMORY.md.\n[REFLECTION TRIGGERED]...\nTimestamp: 2026-07-20 10:30:00
```

**改为：**
```typescript
const scopeTag = project ? `[scope: project/${project}]` : `[scope: global]`;
return `${scopeTag} ${mode === "overwrite" ? "Wrote to" : "Appended to"} ${displayName}.${reflectionPrompt}\n\nTimestamp: ${timestamp}`;
```

**示例输出：**
```
[scope: project/owner/repo] Appended to projects/owner/repo/MEMORY.md.
[scope: global] Appended to MEMORY.md.
[scope: global] Appended to daily/2026-07-20.md.
```

#### 2. `handleRead.ts`

**改为：**
```typescript
const scopeTag = project ? `[scope: project/${project}]` : `[scope: global]`;
// 在 content 前添加 scope 标签
return `${scopeTag}\n\n${content}`;
```

#### 3. `handleEdit.ts`

**改为：**
```typescript
const scopeTag = project ? `[scope: project/${project}]` : `[scope: global]`;
return `${scopeTag} Edited ${displayName}\n\nTimestamp: ${timestamp}`;
```

#### 4. `handleDelete.ts`

**改为：**
```typescript
const scopeTag = project ? `[scope: project/${project}]` : `[scope: global]`;
return `${scopeTag} ${result}\n\nDeleted timestamp: ${timestamp}`;
```

#### 5. `handleSearch.ts`

**改为：**
```typescript
const scopeInfo = searchScope === "global" ? "[scope: global]" : projectId ? `[scope: project/${projectId}]` : "[scope: all]";
return `${scopeInfo} Found ${results.length} results${periodMsg}:\n\n${output}`;
```

### 不变项

- `handleList` 不需要改 —— 它始终作用于全局 daily 目录（L3 之前不变）
- handler 函数签名不变 —— 已有 `project?: string` 参数
- `displayName` 机制不变 —— 继续用于文件路径展示

---

## L2：项目检测增强

### 问题

`detectProject()` 仅依赖 `git remote get-url origin`，无 remote 的本地仓库 fallback 到 `basename(cwd)`，且有以下脆弱点：

1. 无 remote 时 basename 不稳定（多项目同名冲突）
2. 在子目录中运行时 basename 错误（应取 repo root）
3. dotfiles 路径排除过于粗暴

### 方案

采用三级 fallback 策略，按优先级尝试：

```
1. git remote get-url origin  →  解析 owner/repo
2. git rev-parse --show-toplevel  →  取 repo root basename
3. basename(cwd)  →  现有 fallback
```

同时引入 **路径哈希** 作为兜底，确保同名目录也能生成唯一 projectId。

### 具体改动

**文件：** `src/utils/projectDetector.ts`

```typescript
import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { getMemoryDir } from "../config/runtime.js";

/**
 * 探测当前目录所属的项目标识。
 *
 * 三级策略：
 * 1. git remote origin → 解析 owner/repo（最优先）
 * 2. git rev-parse --show-toplevel → repo root basename（本地仓库无 remote）
 * 3. basename(cwd)（最后兜底）
 * 4. 路径哈希（同名目录去重）
 */
export function detectProject(cwd: string = process.cwd()): string | null {
  const resolved = path.resolve(cwd);

  // 排除 memory 自身目录（避免递归）
  if (isWithinMemoryDir(resolved)) return null;

  // 策略 1：git remote
  const remoteId = tryGetRemoteId(resolved);
  if (remoteId) return remoteId;

  // 策略 2：git repo root basename（适用于无 remote 的本地仓库）
  const repoRoot = tryGetRepoRoot(resolved);
  if (repoRoot) {
    const name = path.basename(repoRoot);
    if (isExcludedPath(repoRoot)) return null;
    return deduplicateName(name, repoRoot);
  }

  // 策略 3：目录名
  if (isExcludedPath(resolved)) return null;
  return deduplicateName(path.basename(resolved), resolved);
}

/** 尝试从 git remote origin 解析项目 ID */
function tryGetRemoteId(cwd: string): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (remoteUrl) return parseGitUrl(remoteUrl);
  } catch {}
  return null;
}

/** 尝试获取 git 仓库根目录路径 */
function tryGetRepoRoot(cwd: string): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return path.resolve(root);
  } catch {}
  return null;
}

/** 判断路径是否为 home 目录、dotfiles 目录 */
function isExcludedPath(dirPath: string): boolean {
  const homeDir = os.homedir();
  if (dirPath === homeDir) return true;
  // 排除以 . 开头的隐藏目录（如 ~/.config）
  const segments = path.relative(homeDir, dirPath).split(path.sep);
  if (segments.length > 0 && segments[0] !== ".." && segments[0].startsWith(".")) {
    return true;
  }
  return false;
}

/** 判断路径是否位于 memory 目录下 */
function isWithinMemoryDir(dirPath: string): boolean {
  const memoryDir = getMemoryDir();
  return dirPath.startsWith(memoryDir + path.sep) || dirPath === memoryDir;
}

/**
 * 同名目录去重：取目录名 + 路径哈希前 8 位。
 * 如 "my-project" + hash("/home/user/work/my-project") → "my-project.a1b2c3d4"
 */
function deduplicateName(name: string, dirPath: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(dirPath)
    .digest("hex")
    .slice(0, 8);
  return `${name}.${hash}`;
}

/** 解析 git remote URL 为 owner/repo 格式（与现有逻辑相同） */
function parseGitUrl(url: string): string | null {
  // 不变
}
```

### 设计决策

| 决策 | 理由 |
|------|------|
| 使用 `git rev-parse --show-toplevel` 而非检查 `.git` 目录 | 标准 git 命令，覆盖 worktree/submodule 等场景 |
| 路径哈希去重 | basename 太容易冲突，8 位 hex 碰撞概率极低（~1/4e9） |
| dotfiles 排除改为 `path.relative` 判断 | 更精确，不会误伤 `~/Projects/` 等正常目录 |
| 保持 `parseGitUrl` 不变 | 现有正则已覆盖 HTTPS/SSH/git@ 三种格式 |

### 注意

- L2 改动后，现有测试中 mock 了 `detectProject` 返回 `"owner/repo"`，新测试需要覆盖无 remote 场景
- 使用 `crypto.createHash`（Node.js 内置，无额外依赖）

---

## L3：项目级 Daily 日志

### 问题

`getPathForTarget("daily", ...)` 完全忽略 `project` 参数，所有 daily 日志写入同一个 `daily/` 目录：

```typescript
case "daily": {
  const targetDate = normalizeDailyDate(date) ?? this.todayStr();
  return {
    filePath: this.getDailyPath(targetDate),       // → daily/2026-07-20.md
    displayName: `daily/${targetDate}.md`,
  };
}
```

### 方案

在 `getPathForTarget` 的 `daily` 分支中增加项目路由：

```
project 存在 → projects/{id}/daily/YYYY-MM-DD.md
project 为空 → daily/YYYY-MM-DD.md（现有行为）
```

### 具体改动

#### 1. `MemoryPaths.ts` — 新增 `projectDailyPath`

```typescript
/** 获取项目级 daily 日志路径 */
projectDailyPath(projectId: string, date: string): string {
  return path.join(this.projectDir(projectId), "daily", `${date}.md`);
}
```

#### 2. `MemoryManager.ts` — 修改 `getPathForTarget` 的 `daily` 分支

```typescript
case "daily": {
  const targetDate = normalizeDailyDate(date) ?? this.todayStr();
  if (project) {
    return {
      filePath: this.paths.projectDailyPath(project, targetDate),
      displayName: `projects/${project}/daily/${targetDate}.md`,
    };
  }
  return {
    filePath: this.getDailyPath(targetDate),
    displayName: `daily/${targetDate}.md`,
  };
}
```

#### 3. `MemoryManager.ts` — 修改 `embedAndIndex` 的索引路由

项目级 daily 文件位于 `projects/{id}/daily/` 下，需确保正确路由到项目索引而非全局 daily 索引：

```typescript
// 现有逻辑已按 projectsDir 前缀判断项目文件，无需额外改动
if (filePath.startsWith(projectsDir + path.sep)) {
  const relative = path.relative(projectsDir, filePath);
  const projectId = path.dirname(relative).split(path.sep).join("/");
  // ...
}
```

`projects/owner/repo/daily/2026-07-20.md` 会正确匹配 `projectsDir + path.sep` 前缀，`relative` 为 `owner/repo/daily`，`projectId` 为 `owner/repo` → 路由到正确的 ProjectStore。✅ 无需额外修改。

#### 4. `MemoryManager.ts` — 修改 `persistAndIndex` 的 git 索引追踪

同上，项目 daily 文件的 indexPaths 推导已通过 `projectsDir` 前缀判断，无需修改。

#### 5. `handleWrite.ts` — 确保 `ensureProjectDirs` 也覆盖 daily

当前 `handleWrite` 在 `project && target === "memory"` 时才创建目录：

```typescript
if (project && target === "memory") {
  memoryManager.ensureProjectDirs(project);
}
```

**改为：**

```typescript
if (project && (target === "memory" || target === "daily")) {
  memoryManager.ensureProjectDirs(project);
}
```

#### 6. `handleRead.ts`, `handleEdit.ts`, `handleDelete.ts`

无需改动 —— `getPathForTarget` 已处理路由，handler 只是透传 `project` 参数。

### 不变项

- `handleList` 暂不修改 —— L3 范围限定 daily 的 **写入/读取**，列表功能后续迭代
- 全局 daily 目录结构不变
- `displayName` 格式保持 `<type>/<name>.md` 惯例

---

## 数据流变化

### 修改前

```
AI: memory_write({target:"memory", content:"..."})
  → index.ts: resolveProjectId(scope, projectId) → null（降级）
  → handleWrite({project: undefined})
  → getPathForTarget("memory") → MEMORY.md（全局）
  → 返回值: "Appended to MEMORY.md."
  
AI 无法得知写入了全局。
```

### 修改后

```
AI: memory_write({target:"memory", content:"..."})
  → index.ts: resolveProjectId(scope, projectId) → "owner/repo"（检测成功）
  → handleWrite({project: "owner/repo"})
  → getPathForTarget("memory", _, "owner/repo") → projects/owner/repo/MEMORY.md
  → 返回值: "[scope: project/owner/repo] Appended to projects/owner/repo/MEMORY.md."

AI: memory_write({target:"daily", content:"..."})
  → index.ts: resolveProjectId(scope, projectId) → "owner/repo"
  → handleWrite({project: "owner/repo"})
  → getPathForTarget("daily", "2026-07-20", "owner/repo") → projects/owner/repo/daily/2026-07-20.md
  → 返回值: "[scope: project/owner/repo] Appended to projects/owner/repo/daily/2026-07-20.md."
```

---

## 涉及文件清单

| 文件 | 改动类型 | L1 | L2 | L3 |
|------|---------|:--:|:--:|:--:|
| `src/handlers/handleWrite.ts` | 添加 scope 标签 + 扩展 ensureProjectDirs | ✓ | | ✓ |
| `src/handlers/handleRead.ts` | 添加 scope 标签 | ✓ | | |
| `src/handlers/handleEdit.ts` | 添加 scope 标签 | ✓ | | |
| `src/handlers/handleDelete.ts` | 添加 scope 标签 | ✓ | | |
| `src/handlers/handleSearch.ts` | 添加 scope 标签 | ✓ | | |
| `src/utils/projectDetector.ts` | 三级 fallback + 路径哈希 | | ✓ | |
| `src/memory/MemoryPaths.ts` | 新增 `projectDailyPath` | | | ✓ |
| `src/memory/MemoryManager.ts` | `getPathForTarget` daily 项目路由 | | | ✓ |
| `tests/high-risk.test.ts` | 新增 L1/L2/L3 测试 | ✓ | ✓ | ✓ |

---

## 测试策略

### L1 测试

1. `handleWrite` 返回包含 `[scope: project/owner/repo]` 标签
2. `handleWrite` 返回包含 `[scope: global]` 标签（无 project 时）
3. `handleRead` 返回内容前含 scope 标签
4. `handleEdit` 返回含 scope 标签
5. `handleDelete` 返回含 scope 标签
6. `handleSearch` 返回含 scope 信息

### L2 测试

7. `detectProject()` 在无 remote 的本地 git 仓库中返回有效 projectId
8. `detectProject()` 在非 git 目录中使用 basename + 哈希
9. `detectProject()` 排除 home 目录（返回 null）
10. `detectProject()` 排除 memory 自身目录（返回 null）
11. `detectProject()` 在子目录中取 repo root basename

### L3 测试

12. `target=daily` + `project=owner/repo` → 写入 `projects/owner/repo/daily/2026-07-20.md`
13. `target=daily` + 无 project → 写入 `daily/2026-07-20.md`（现有行为不变）
14. 项目 daily 文件索引路由到 ProjectStore（非全局 daily 索引）
15. 全局 daily 不受影响

---

## 假设与不确定项

1. **假设**：`git rev-parse --show-toplevel` 在所有 git 版本（≥2.0）中可用。Node.js `execSync` 环境需 git 在 PATH 中。
2. **不确定**：L3 的 `handleList` 是否需要项目级 daily 列表？PRD 未要求，暂不实现。
3. **不确定**：`FileSearcher.searchFiles`（关键词搜索）和 `listFiles` 是否也应支持 project daily？PRD 未要求，暂不修改。
4. **假设**：`crypto.createHash` 在 Node.js ≥18 中可用（项目 target 为 ES2022，满足条件）。

---

## 任务拆解（DAG）

```
L2（项目检测）
  ↓
L3（daily 项目路由）  ← 依赖 L2 的稳定 projectId
  ↓
L1（scope 透明化）     ← 可与 L3 并行，但需 L3 完成后统一测试
```

| 任务 | 说明 | 预估 |
|------|------|------|
| T1: 增强 projectDetector | 三级 fallback + 路径哈希 | 2h |
| T2: 项目级 daily 路由 | MemoryPaths + MemoryManager + handleWrite | 2h |
| T3: handler scope 标签 | 5 个 handler 返回值添加 scope | 1.5h |
| T4: 测试覆盖 | 新增 L1/L2/L3 测试，确保现有测试通过 | 2h |
