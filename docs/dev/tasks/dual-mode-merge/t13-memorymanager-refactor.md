---
name: "MemoryManager 改造"
phase: 3
depends_on: ["T10", "T11"]
labels: ["backend"]
worktree_root: ".worktree/t13-memorymanager-refactor/"
test_commands:
  - "bun test tests/high-risk.test.ts"
  - "pnpm exec tsc --noEmit"
verify_commands:
  - "bun test"
  - "pnpm exec tsc --noEmit"
tdd:
  mode: strict
  min_cycles: 2
acceptance:
  - criteria: "MemoryManager 构造函数支持可选的 providers 参数注入"
    verification_type: test
    test_command: "bun test"
  - criteria: "未注入 providers 时，内部自动创建 LocalProvider（向后兼容）"
    verification_type: test
    test_command: "bun test"
  - criteria: "persistAndIndex 在 local 模式下行为与重构前一致"
    verification_type: test
    test_command: "bun test tests/high-risk.test.ts"
  - criteria: "getPathForTarget 在 remote 模式下返回 'file_type:date:project_id' 格式路径"
    verification_type: test
    test_command: "bun test"
  - criteria: "gitCommit 在 remote 模式下被跳过"
    verification_type: test
    test_command: "bun test"
  - criteria: "StateChecker/BootstrapManager 使用 IFileStorageProvider.exists 判断状态"
    verification_type: test
    test_command: "bun test"
---

# T13: MemoryManager 改造

**阶段**：Phase 3 — 插件双模式
**依赖**：T10（接口定义）, T11（LocalProvider 实现）
**标签**：`backend`
**预估**：2h

## 目标

重构 `MemoryManager` 的核心逻辑，支持 Provider 注入和运行模式感知。保持向后兼容，local 模式行为与 v1.2.0 完全一致。

## 背景

这是插件改动的核心任务。需要将 `MemoryManager` 中紧耦合的 fs/vectra/huggingface 调用，重构为通过 Provider 接口间接调用。同时需要适配 `FileSearcher` 支持 remote 模式的搜索路径。

## 实现步骤

### 1. 构造函数扩展

```typescript
import type { Providers } from "../providers/factory.js";
import type { MemoryMode } from "../providers/factory.js";

export class MemoryManager {
  private config: MemoryConfig;
  private paths: MemoryPaths;
  private providers: Providers | null = null;
  private mode: MemoryMode;

  constructor(config: MemoryConfig, providers?: Providers) {
    this.config = config;
    this.paths = new MemoryPaths(config.memoryDir);
    this.mode = config.mode ?? "local";

    if (providers) {
      this.providers = providers;
    }
    // 未注入 providers 时保持向后兼容 — 内部方法直接使用原有逻辑
    // （仅当 mode=local 且 providers 未注入时触发 legacy 路径）

    this.stateChecker = new StateChecker(config.memoryDir);
    this.fileSearcher = new FileSearcher(
      config.memoryDir,
      this.paths.dailyDir,
      (p) => this.readFile(p),
      (id) => this.getProjectStore(id),
      this.mode,  // 🆕 传递 mode 供搜索适配
    );
  }
```

### 2. `getPathForTarget` 适配 remote 模式

在 remote 模式下返回特殊格式的路径字符串：

```typescript
getPathForTarget(target: string, date?: string, project?: string | null): { filePath: string; displayName: string } {
  // local 模式：保持现有逻辑不变
  if (this.mode !== "remote") {
    // ... 现有 switch 逻辑
  }

  // remote 模式：返回 "file_type:date:project_id" 格式
  const fileType = target;  // memory, identity, user, daily
  const effectiveDate = target === 'daily' ? (normalizeDailyDate(date) ?? this.todayStr()) : '';
  const effectiveProject = project ?? '';

  const filePath = `${fileType}:${effectiveDate}:${effectiveProject}`;
  return { filePath, displayName: filePath };
}
```

### 3. `persistAndIndex` 适配 Provider

```typescript
private async persistAndIndex(filePath: string, content: string, operation: string): Promise<void> {
  if (this.providers) {
    // Provider 路径
    await this.providers.fileStorage.writeFile(filePath, content);
    // local 模式：embed + index + git commit
    if (this.mode === "local") {
      await this.embedAndIndex(filePath, content);
      await gitCommit(operation, filePath, this.config.memoryDir, indexPaths);
    }
    // remote 模式：Worker 侧自动 embed + index，skip git commit
    return;
  }

  // Legacy 路径（无 providers 注入时）
  atomicWrite(filePath, content);
  await this.embedAndIndex(filePath, content);
  await gitCommit(operation, filePath, this.config.memoryDir, indexPaths);
}
```

### 4. FileSearcher 改造

在 `FileSearcher` 中新增 remote 搜索路径：

```typescript
// FileSearcher 构造函数新增 mode 和 remote search client 参数
constructor(
  private memoryDir: string,
  private dailyDir: string,
  private readFile: (filePath: string) => string | null,
  private getProjectStore: (projectId: string) => ProjectStore,
  private mode: MemoryMode = "local",
  private remoteSearch?: (query: string, topK: number, fileType?: string, projectId?: string) => Promise<SemanticSearchResult[]>,
) {}

async semanticSearch(...): Promise<SemanticSearchResult[]> {
  if (this.mode === "remote" && this.remoteSearch) {
    // remote 模式：跳过本地 embed，直接通过 remoteSearch 调用 Worker /api/memories/search
    const results = await this.remoteSearch(query, maxResults, fileType, projectId);
    // period 过滤在客户端执行
    if (period) {
      return results.filter(r => r.timestamp?.startsWith(period)).slice(0, maxResults);
    }
    return results;
  }

  // local 模式：保持现有逻辑不变
  // ...
}
```

### 5. 其他适配点

- `readFile/writeFile/appendFile/deleteFile/fileExists`：在 Provider 模式下委托给 `this.providers.fileStorage`
- `embedAndIndex`：在 Provider 模式下委托给 `this.providers.vectorIndex` + `this.providers.embedding`
- `gitCommit`：remote 模式下跳过（D1 auto-persist）
- `StateChecker`：使用 provider 的 `exists` 判断文件状态

### 6. 验证

```bash
bun test                          # 全量回归
bun test tests/high-risk.test.ts  # 高风险回归 — 重点验证 local 模式零行为变化
pnpm exec tsc --noEmit            # 类型检查
```

## 文件变更

| 操作 | 文件 |
|------|------|
| ✏️ 修改 | `src/memory/MemoryManager.ts`（构造函数、persistAndIndex、getPathForTarget） |
| ✏️ 修改 | `src/memory/FileSearcher.ts`（构造函数、semanticSearch 新增 remote 分支） |
| ✏️ 修改 | `src/memory/StateChecker.ts`（如需要 provider.exists） |

## 注意事项

- **向后兼容最高优先级**：未注入 providers 时必须走 legacy 路径，行为与 v1.2.0 完全一致
- **remote 模式不调用 gitCommit**：D1 自动持久化，git 管理不适用于远程存储
- **getPathForTarget 的 remote 输出格式**为 `"file_type:date:project_id"`，需要与 T12 的 `RemoteFileStorageProvider.parsePath()` 保持一致
- **BootstrapManager** 的引导逻辑在 remote 模式下跳过（out of scope，Phase 3 再处理）
