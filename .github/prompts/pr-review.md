请审查本次 PR 的代码改动。

输入：
- @/tmp/pr-diff/full.patch：已排除 lockfile 与生成物的完整改动 diff，是本次审查的事实来源
- @/tmp/pr-diff/stat.txt：按文件的变更统计
- @/tmp/pr-diff/commits.txt：提交历史

审查方式：
1. 先通读 full.patch，不要逐个文件浏览整个代码库；确需补充上下文时，最多再读 10 个文件（优先 apps/api/src/auth/、apps/api/src/services/、apps/api/src/search/hybrid.ts、apps/plugin/src/、packages/shared/src/）。
2. 重点排查维度：
   - 业务逻辑正确性与边界处理（数据模型统一、空值、异常分支、生命周期）
   - 安全性（越权访问、鉴权绕过、SQL/FTS注入、敏感配置泄露、CORS凭据安全）
   - 检索与性能（两桶分层混合检索稳定性、分面过滤、Cron 定时任务幂等与死循环防范）
   - 架构与类型契约（Shared 领域模型、OpenCode 插件薄客户端、Pi 扩展、MCP 协议一致性）
   - 单测覆盖有效性与回归风险
3. 每条问题必须能定位到具体文件与行号，并说明"为什么是问题"和整改方向；不要报纯格式问题或无依据的猜测。

输出报告（总长控制在 2000 字以内）：
- 总体结论与风险评级（推荐合并 / 建议优化 / 存在风险）
- 架构重构亮点说明
- 分级问题清单（按 Critical / High / Medium 分级，指明具体文件、代码行与整改方案）
- 合并前核查清单

完成后必须用 write 工具把完整报告写入仓库根目录的 `review-report.md`（Markdown，UTF-8），
工作流会以该文件作为 PR 评论正文；同时把同样内容作为最终回复输出。
