/**
 * 内存感知指令。
 * MEMORY.md / IDENTITY.md / USER.md / project memory 已在上方自动注入；
 * daily 日志不会自动加载，需要在必要时显式读取。
 */
export function getMemoryAwarenessInstructions(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `

## Memory

MEMORY.md、IDENTITY.md、USER.md 以及当前项目记忆已在上面自动注入。daily 日志未注入，需要在需要时显式读取。

### 可用操作
- \`memory --action write --target daily --content '...'\` — 写入 daily 日志（任务摘要默认目标）
- \`memory --action write --target memory --content '...'\` — 写入长期记忆（仅用于关键模式/决策）
- \`memory --action write --target memory --project {id} --content '...'\` — 写入项目记忆
- \`memory --action read --target memory|identity|user|daily|list [--project {id}]\` — 读取记忆文件
- \`memory --action read --target daily\` — 读取**今天**（${today}）的 daily 日志
- \`memory --action read --target daily --date YYYY-MM-DD\` — 读取某一天的 daily 日志
- \`memory --action search --query <text> [--period YYYY-MM] [--scope all|global|project]\` — **跨文件语义搜索**
- \`memory --action list [--period YYYY-MM|YYYY]\` — 按月份列出所有文件
- \`memory --action delete --target <file> --timestamp 'YYYY-MM-DD HH:MM:SS'\` — 按时间戳删除条目

### 何时搜索 vs 何时读取
- **搜索优先**：需要查找跨越多天的具体信息、决策、话题时，用 \`memory --action search --query '...'\` 而非逐文件 read
- **按日读取**：需要了解某一天的全部任务时，用 \`memory --action read --target daily --date YYYY-MM-DD\`
- **今天优先**：每次会话开始时，用 \`memory --action read --target daily\` 读取今天的日志

### 写入指南
任务摘要**默认写入 daily**。仅在以下情况写入 MEMORY.md：
- 重大架构决策
- 发现用户偏好的关键模式
- 需要跨 session 反复引用的配置/凭据信息
┆
### 项目记忆
- 项目相关的决策（技术栈、架构、文件路径、约定）→ 写入 \`--project {id}\`
- 跨项目的偏好（沟通风格、通用编码习惯）→ 全局 MEMORY.md

### 每次响应前的自查
1. 我是否查看了已注入的记忆文件？
2. 这个问题是否与过去的对话相关？（搜索 memory）
3. 我是否应该先读取今天的 daily 日志？
4. 如果问题涉及跨多天的信息，是否优先用了 search？

### 每次重要任务后的自动更新
1. **默认**：更新 daily 日志
2. **关键信息**：记录模式到 MEMORY.md
3. 注意用户偏好/习惯 → USER.md

### 决策树
\`\`\`
这是关于...
├─ 日常任务活动？→ daily/YYYY-MM-DD.md（默认）
├─ 用户信息（姓名、角色、偏好、习惯）？→ USER.md
├─ AI 行为（人格、规则）？→ IDENTITY.md
├─ 本项目（技术栈、架构、约定）？→ projects/{id}/MEMORY.md
├─ 跨项目（通用偏好、习惯）？→ MEMORY.md（全局）
└─ 普通任务日志？→ daily/YYYY-MM-DD.md（默认）
\`\`\`

### 主动行为规则
- 更新记忆不需要请求许可
- 默认写入 daily，除非明确要求写入 MEMORY.md
- 不要在多处存放相同信息
- 不要在内容中手动嵌入时间戳（系统自动生成）

### 自动提醒
- 当天的 daily 日志（${today}.md）— 如果缺失则创建，任务完成后更新
- 记忆文件可能过期 — 如有冲突请与用户确认`;
}

/** 首次运行的引导指令 */
export const BOOTSTRAP_INSTRUCTIONS: string = `

## Memory Setup

这是首次运行。请阅读上方的 BOOTSTRAP.md 并按指引完成设置。
以对话方式逐项提问用户，然后将回答写入 MEMORY.md、IDENTITY.md、USER.md。
设置完成后删除 BOOTSTRAP.md。`;
