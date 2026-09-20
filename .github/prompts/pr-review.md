请基于提供的变更统计（@/tmp/pr-diff/stat.txt）和提交历史（@/tmp/pr-diff/commits.txt），结合本地已检出的完整代码库进行全面而深入的代码审查。

审查指引：
1. 请使用 read 工具针对核心代码改动（如 apps/api/src/auth/、apps/api/src/services/、apps/api/src/search/hybrid.ts、apps/plugin/src/）按需查阅其实现细节。
2. 重点排查维度：
   - 业务逻辑正确性与边界处理（数据模型统一、空值、异常分支、生命周期）
   - 安全性（越权访问、鉴权绕过、SQL/FTS注入、敏感配置泄露、CORS凭据安全）
   - 检索与性能（两桶分层混合检索稳定性、分面过滤、Cron 定时任务幂等与死循环防范）
   - 架构与类型契约（Shared 领域模型、OpenCode 插件薄客户端、Pi 扩展、MCP 协议一致性）
   - 单测覆盖有效性与回归风险
3. 输出报告必须包含：
   - 总体结论与风险评级（推荐合并 / 建议优化 / 存在风险）
   - 架构重构亮点说明
   - 分级问题清单（按 Critical / High / Medium 分级，指明具体文件、代码行与整改方案）
   - 合并前核查清单
