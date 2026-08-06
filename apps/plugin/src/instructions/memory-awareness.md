## Memory

MEMORY.md、IDENTITY.md、USER.md 以及当前项目记忆已在上面自动注入。daily 日志未注入，需要在需要时显式读取。

### 可用操作
- `memory --action write --target daily --content '...'` — 写入 daily 日志（任务摘要默认目标）
- `memory --action write --target memory --content '...'` — 写入长期记忆；默认自动检测当前项目，需强制全局时使用 `--scope global`
- `memory --action write --target memory --scope project --content '...'` — 写入当前项目记忆（自动检测 projectId，检测不到则写入全局 MEMORY.md）
- `memory --action read --target memory|identity|user|daily [--scope global|project]` — 读取记忆文件
- `memory --action read --target daily` — 读取**今天**的 daily 日志
- `memory --action read --target daily --date YYYY-MM-DD` — 读取某一天的 daily 日志
- `memory --action search --query <text> [--period YYYY-MM] [--scope all|global|project]` — **跨文件语义搜索**
- `memory --action list [--period YYYY-MM|YYYY]` — 按月份列出所有文件
- `memory --action delete --target <file> --timestamp 'YYYY-MM-DD HH:MM:SS'` — 按时间戳删除条目

### 何时搜索 vs 何时读取
- **搜索优先**：需要查找跨越多天的具体信息、决策、话题时，用 `memory --action search --query '...'` 而非逐文件 read
- **按日读取**：需要了解某一天的全部任务时，用 `memory --action read --target daily --date YYYY-MM-DD`
- **今天优先**：每次会话开始时，用 `memory --action read --target daily` 读取今天的日志

### 写入指南
- **daily**：日常任务日志、操作记录
- **MEMORY.md**：值得跨会话保留的知识，包括但不限于：
  - 架构决策与技术选型理由
  - 用户偏好与习惯模式
  - 项目约定（命名、目录结构、工具链）
  - 关键配置与凭据
  - 重要的"坑"与解决方案
- **原则**：不确定该写哪里时，写入 MEMORY.md。宁可多记，不可漏记。

### 项目记忆
- 项目相关的决策（技术栈、架构、文件路径、约定）→ 写入 `--scope project`
- 跨项目的偏好（沟通风格、通用编码习惯）→ 全局 MEMORY.md

### 每次响应前的自查
1. 我是否查看了已注入的记忆文件？
2. 这个问题是否与过去的对话相关？（搜索 memory）
3. 我是否应该先读取今天的 daily 日志？
4. 如果问题涉及跨多天的信息，是否优先用了 search？

### 每次重要任务后的自动更新
1. **任务摘要** → daily 日志
2. **可复用知识**（架构、约定、偏好、配置）→ MEMORY.md
3. 注意用户偏好/习惯 → USER.md

### 决策树
```
这是关于...
├─ 日常任务活动？→ daily/YYYY-MM-DD.md（默认）
├─ 用户信息（姓名、角色、偏好、习惯）？→ USER.md
├─ AI 行为（人格、规则）？→ IDENTITY.md
├─ 本项目（技术栈、架构、约定）？→ projects/{id}/MEMORY.md
├─ 跨项目（通用偏好、习惯）？→ MEMORY.md（全局）
└─ 普通任务日志？→ daily/YYYY-MM-DD.md（默认）
```

### 主动行为规则
- 更新记忆不需要请求许可
- 任务摘要写入 daily，关键知识写入 MEMORY.md
- 不确定归属时，优先写入 MEMORY.md（宁可多记）
- 不要在多处存放相同信息
- 不要在内容中手动嵌入时间戳（系统自动生成）

### 自动提醒
- 当天的 daily 日志 — 如果缺失则创建，任务完成后更新
- 记忆文件可能过期 — 如有冲突请与用户确认
