# Design: project-memory-isolation

## Overview

为 opencode-memory 插件引入项目级别的记忆隔离。核心思路：**目录隔离 + Vectra 实例分治**，最小化对现有架构的侵入。

## Goals

1. 项目记忆与全局记忆文件系统分离
2. 项目记忆仅在与该项目相关的会话中注入上下文
3. 语义搜索支持按项目范围过滤
4. 100% 向后兼容（不传新参数 = 旧行为）

## Technical Approach

### 项目检测

新增 `src/projectDetector.ts`：

```typescript
function detectProject(cwd: string): string | null
```

**检测流程**：
1. 在 `cwd` 下执行 `git -C <cwd> remote get-url origin`
2. 解析 URL，提取 `owner/repo` 作为项目 ID
   - `git@github.com:anomalyco/opencode.git` → `anomalyco/opencode`
   - `https://github.com/anomalyco/opencode.git` → `anomalyco/opencode`
3. 若失败，取 `path.basename(cwd)` 作为项目 ID
4. 若 cwd 是 home 目录或 memoryDir 的父目录/同级 → 返回 `null`

**免哈希/映射文件**：直接用 git remote 的 `owner/repo`，避免目录重命名导致的映射断裂。无需持久化映射文件。

### 文件系统布局

```
~/.config/opencode/memory/
├── MEMORY.md                    ← 全局记忆（现有，不改）
├── IDENTITY.md                  ← 全局身份（现有，不改）
├── USER.md                      ← 全局用户画像（现有，不改）
├── daily/                       ← 全局日志（现有，不改，涵盖所有项目）
├── root.index/                  ← 全局 root 索引（现有，不改）
├── daily.index/                 ← 全局 daily 索引（现有，不改）
└── projects/
    └── {projectId}/
        ├── MEMORY.md            ← 项目记忆
        └── root.index/          ← 项目 root 索引
```

**设计决策**：daily 日志保持全局。理由：
- daily 是跨项目时间线流水记录，拆分会破坏时序完整性
- 减少每项目索引文件数（从 2 个降到 1 个）
- 消除 daily 写入路由逻辑

### VectorStore 复用法

**关键洞察**：`VectorStore` 类接受 `basePath` 参数，在 `{basePath}/root.index/` 下管理 root 索引。`daily.index` 由全局 VectorStore 统一管理。无需修改 VectorStore 类本身。

```typescript
// 现有代码（不变）
const globalStore = new VectorStore(memoryDir);
// → 索引路径: memoryDir/root.index/, memoryDir/daily.index/

// 新增：为每个项目创建独立 VectorStore 实例（仅 root 索引）
const projectStore = new VectorStore(path.join(memoryDir, 'projects', projectId));
// → 索引路径: memoryDir/projects/{id}/root.index/
//   （项目 VectorStore 不使用 daily.index，因为 daily 保持全局）
```

**MemoryManager 变更**：

```typescript
class MemoryManager {
  private globalStore: VectorStore;           // 现有
  private projectStores: Map<string, VectorStore>;  // 新增：懒创建
  
  getProjectStore(projectId: string): VectorStore {
    if (!this.projectStores.has(projectId)) {
      this.projectStores.set(projectId, new VectorStore(
        path.join(this.config.memoryDir, 'projects', projectId)
      ));
    }
    return this.projectStores.get(projectId)!;
  }
}
```

### 上下文注入变更

`buildContext()` 方法接收可选 `projectId` 参数：

```typescript
function buildContext(projectId?: string | null): string | null
```

注入顺序：
1. 若 BOOTSTRAP.md 存在 → 仅注入 BOOTSTRAP.md（不变）
2. 读全局 MEMORY.md + IDENTITY.md + USER.md（不变）
3. 若 `projectId` 存在 → 追加读取 `projects/{projectId}/MEMORY.md`
4. 格式化输出

项目区块仅在项目 MEMORY.md 存在且非空时追加。

### 搜索变更

`semanticSearch()` 新增 `projectId` 参数：

```typescript
async semanticSearch(query: string, topK: number, projectId?: string): Promise<SemanticSearchResult[]>
```

搜索逻辑：
1. 始终查询 globalStore（root + daily）
2. 若 `projectId` 存在 → 附加查询 projectStore（仅 root，daily 在全局索引中已覆盖）
3. 合并结果 → 按 score 排序 → 取 topK

新增 `SearchScope` 类型控制搜索范围：
```typescript
type SearchScope = 'all' | 'global' | 'project'
```

### 写入路由

`handleWrite()` 变更：

```
--target memory (无 --project)  → 全局 MEMORY.md
--target memory --project {id}  → projects/{id}/MEMORY.md
--target daily                  → 始终全局 daily/（不受 project 影响）
--target identity/user          → 始终全局（不受 project 影响）
```

同理，`handleRead()` 支持 `--project` 参数。

### 工具参数扩展

`memory` 工具配置中新增两个可选参数：

```typescript
{
  name: "scope",
  type: "string",
  description: "搜索范围：all（默认）| global | project",
  required: false,
},
{
  name: "project",
  type: "string",
  description: "指定项目 ID，留空则自动检测",
  required: false,
}
```

### Git 版本控制

当前整个 memoryDir 是一个 Git 仓库。项目目录在 `memoryDir/projects/` 下，自然被同一个 Git 仓库覆盖，无需额外处理。

## Alternatives Considered

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| **A. 独立 VectorStore 实例** | VectorStore 类零改动；隔离彻底 | 每项目多 1 个索引目录 | **采用**（改动最小） |
| B. 单 VectorStore + metadata 过滤 | 索引文件数恒定 | 需 Vectra 支持 metadata 过滤（未验证 API）；改动力度大 | 不采用 |
| C. 文件名加前缀（如 `luckyc-memory.md`） | 无需目录结构变更 | 文件散乱；无隔离概念 | 不采用 |

## Impacted Files / Modules

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `src/index.ts` | **中** | `buildContext()` 注入项目记忆；`handleSearch`/`handleWrite`/`handleRead` 路由变更；工具参数扩展 |
| `src/MemoryManager.ts` | **大** | 新增 `projectStores` Map；路径辅助方法；`semanticSearch` 支持 project；写入路由 |
| `src/projectDetector.ts` | **新文件** | `detectProject(cwd)` 函数 |
| `src/types.ts` | 小 | 新增 `SearchScope` 类型；`ContextFile` 可能扩展 |
| `src/config.ts` | 极小 | 可能新增 `getProjectDir(projectId: string)` 工具函数 |
| `src/vector-store.ts` | **零** | 不改动（通过实例化独立 VectorStore 实现隔离） |
| `src/chunker.ts` | **零** | 不改动 |
| `src/embedding.ts` | **零** | 不改动 |
| `src/validation.ts` | 小 | 新增 `project` 参数校验 |
| `src/memoryInstructions.ts` | 小 | 指令中可能需要提及项目级记忆的存在 |

## Risks and Mitigations

| 风险 | 缓解 |
|------|------|
| 项目 ID 重复（不同路径解析出同一项目 ID） | git remote 先提取 `owner/repo`，天然去重；目录名 fallback 为同台机器场景 |
| Vectra 索引数量随项目增长 | 懒创建（无写入不建索引）；10 个项目 = 10 个额外索引 → 每个 ~1-5MB，总量可控 |
| 项目切换时索引冷启动 | 首次搜索项目时 lazy 检查索引是否存在，若不存在则 embed；后续搜索命中即有索引 |
| 全局 MEMORY.md 和项目 MEMORY.md 内容重复 | 文档/指令中引导：全局放跨项目通用偏好，项目放项目特定决策 |
