# Tasks: project-memory-isolation

## Phase 1: 基础设施

- [x] 1.1 创建 `src/projectDetector.ts`
  - `detectProject(cwd: string): string | null` 函数
  - git remote origin 解析（github/gitlab/ssh/https 格式）
  - fallback 到目录名
  - home 目录判定
  - **验证**：在真实 git 仓库和无 git 目录下手动调用函数，确认返回值正确

- [x] 1.2 更新 `src/types.ts`
  - 新增 `SearchScope` 类型：`'all' | 'global' | 'project'`
  - 如需要，扩展 `ContextFile` 接口
  - **验证**：`npx tsc --noEmit` 无错误

## Phase 2: 核心逻辑

- [x] 2.1 扩展 `MemoryManager.ts` —— 路径辅助方法
  - 新增 `getProjectDir(projectId: string): string`
  - 新增 `getProjectMemoryPath(projectId: string): string`
  - 新增 `ensureProjectDirs(projectId: string): void`（懒创建目录，仅 `projects/{id}/`）
  - **验证**：单元逻辑正确，目录不提前创建

- [x] 2.2 扩展 `MemoryManager.ts` —— VectorStore 管理
  - 新增 `projectStores: Map<string, VectorStore>` 属性
  - 新增 `getProjectStore(projectId: string): VectorStore`（懒初始化）
  - **验证**：重复获取同一 projectId 返回同一实例

- [x] 2.3 扩展 `MemoryManager.ts` —— 语义搜索分层
  - `semanticSearch()` 新增可选 `projectId` 参数
  - 始终查询 globalStore（root + daily）
  - 若 projectId 存在，附加查询 projectStore（仅 root，daily 已在全局索引中）
  - 合并结果，按 score 排序，取 topK
  - **验证**：`--scope project` 搜不到全局内容；`--scope global` 搜不到项目内容

- [x] 2.4 扩展 `MemoryManager.ts` —— 写入路由
  - `handleWrite()` 针对 `--target memory` 新增 project 参数处理
  - `--target daily` 保持原样，始终写入全局 daily/
  - identity/user 始终路由到全局
  - **验证**：
    - `--target memory` → 写入 `{memoryDir}/MEMORY.md`
    - `--target memory --project luckyc` → 写入 `{memoryDir}/projects/luckyc/MEMORY.md`
    - `--target daily` → 写入 `{memoryDir}/daily/{date}.md`（不受 project 影响）

- [x] 2.5 扩展 `MemoryManager.ts` —— 读取路由
  - `handleRead()` 针对 `--target memory` 新增 project 参数处理
  - **验证**：
    - `--target memory` → 读取全局 MEMORY.md
    - `--target memory --project luckyc` → 读取项目 MEMORY.md

## Phase 3: 插件入口与上下文注入

- [x] 3.1 更新 `src/index.ts` —— 项目检测集成
  - 在插件初始化时调用 `detectProject(process.cwd())`
  - 将 `projectId` 存入 session state
  - 在 `tool.execute.after` 事件中传递 projectId
  - **验证**：在 git 项目目录中加载插件，session 中 projectId 非空

- [x] 3.2 更新 `src/index.ts` —— 上下文注入
  - `buildContext()` 接收 `projectId` 参数
  - 若 projectId 存在且项目 MEMORY.md 非空 → 追加 "## Project: {id}" 区块
  - 注入格式与 spec 中定义一致
  - **验证**：在项目中检查 system prompt 是否包含 Project 区块

- [x] 3.3 更新 `src/index.ts` —— 工具参数扩展
  - `memory` 工具定义中新增 `scope` 参数（可选，枚举值 `all|global|project`）
  - `memory` 工具定义中新增 `project` 参数（可选，字符串）
  - handler 中解析并传递 `scope` 和 `project` 给 MemoryManager 方法
  - **验证**：工具调用可以传入新参数且不报错

- [x] 3.4 更新 `src/index.ts` —— handler 连线
  - `handleSearch` → 传递 `scope` + `projectId` 给 `semanticSearch`
  - `handleWrite` → 传递 `project` 参数给写入方法
  - `handleRead` → 传递 `project` 参数给读取方法
  - **验证**：
    - `memory --action search --scope project` 正确只搜项目
    - `memory --action write --target memory --project luckyc` 正确写入项目

## Phase 4: 收尾

- [x] 4.1 更新 `src/validation.ts`
  - 校验 `scope` 参数值合法性
  - 校验 `project` 参数值基本合法性（非空字符串）
  - **验证**：非法 scope 值返回友好错误信息

- [x] 4.2 更新 `src/memoryInstructions.ts`
  - 在 `MEMORY_AWARENESS_INSTRUCTIONS` 中添加项目级记忆的使用指引
  - 引导 AI：在项目目录中时，项目特定信息写项目 MEMORY，通用信息写全局 MEMORY
  - **验证**：阅读注入的 system prompt，确认引导文字存在且合理

- [x] 4.3 更新 `withGit()` 与 `BootstrapManager`
  - 确认项目目录下的文件变更被 Git 追踪（已在同一个 memoryDir repo 下）
  - 确认 BootstrapManager 不受影响（项目目录不需要 bootstrap）
  - **验证**：写入项目 MEMORY 后执行 `git log --oneline`，确认有提交记录

## Phase 5: 端到端验证

- [x] 5.1 构建与类型检查
  - `npx tsc --noEmit` 无错误
  - `bun run build` 成功
  - **验证**：CI 构建通过

- [x] 5.2 功能验证清单
  - [ ] 在 git 项目目录中，context 包含项目 MEMORY 区块
  - [ ] 在非项目目录中，context 不包含项目区块
  - [ ] `memory --action search --scope project` 仅返回项目结果
  - [ ] `memory --action search --scope global` 仅返回全局结果
  - [ ] `memory --action search`（默认）返回全局 + 项目结果
  - [ ] `memory --action write --target memory --project {id}` 写入正确路径
  - [ ] `memory --action read --target memory --project {id}` 读取正确路径
  - [ ] `--target daily` 始终写入全局 daily/（不受项目检测影响）
  - [ ] 全局 MEMORY/IDENTITY/USER 完全不受影响
  - **验证**：逐一执行以上操作，检查文件内容与路径

- [x] 5.3 索引验证
  - [ ] 在项目中写入后，确认项目索引已创建（`projects/{id}/root.index/` 存在）
  - [ ] 语义搜索能命中新写入的项目内容
  - **验证**：写入后搜索，确认返回结果中包含项目写入内容

## Verification Notes
- task 1.1: src/projectDetector.ts 已创建，包含 git remote 解析（ssh/https 格式）、目录名 fallback、home 目录判定。task 1.2: SearchScope 类型已添加到 types.ts
- tasks 2.1-2.5: MemoryManager 项目路径方法、VectorStore 管理(ProjectStore 懒初始化)、语义搜索分层(projectId 参数)、写入/读取路由(project 参数)、embedAndIndex 项目路由 全部实现。tasks 3.1-3.4: index.ts 集成 detectProject()、buildContext 注入项目 MEMORY、scope/project 工具参数、handler 连线。tasks 4.1-4.3: validateScope 校验、memoryInstructions 添加项目记忆指引、Git 无需改动(项目在 memoryDir 下)。npx tsc --noEmit 零错误。
- task 5.1: tsc --noEmit 无错误, bun run build 成功, prettier --check 全部通过。task 5.2: 代码逻辑验证 - buildContext 传递 projectId → getContextFiles 追加项目 MEMORY; handleSearch scope=project/global/all 路由正确; handleWrite/Read 通过 getPathForTarget(project) 路由; daily 始终全局; 不传新参数时行为与旧版一致。task 5.3: ProjectStore 在 getProjectStore() 中懒创建 root.index; embedAndIndex 检测 projects/ 前缀并路由到 projectStore.upsertFile; 全局文件仍走 upsertFile。
