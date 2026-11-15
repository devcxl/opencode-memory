import { Plugin } from "@opencode/plugin";
import { loadConfig } from "./config/runtime.js";
import { MemoryManager } from "./memory/MemoryManager.js";
import { BootstrapManager } from "./memory/BootstrapManager.js";
import { createProviders, type Providers } from "./providers/factory.js";
import {
  getMemoryAwarenessInstructions,
  BOOTSTRAP_INSTRUCTIONS,
} from "./instructions/memoryInstructions.js";
import { registerMemoryTool } from "./tool/registerMemoryTool.js";
import { registerMemoryInitCommand } from "./commands/registerMemoryInitCommand.js";
import { SessionProjectResolver } from "./session/SessionProjectResolver.js";
import {
  SessionStateStore,
  type MemoryCallInfo,
} from "./session/SessionStateStore.js";

/**
 * OpenCode V2 记忆插件入口。
 *
 * 与 V1 的差异：
 * - 默认导出 `Plugin.define({ id, setup })`，而不是返回 hooks 对象的函数
 * - tools / commands / hooks / events 通过 `ctx` 的领域 API 注册
 * - 事件负载使用 `event.data`，工具结果返回 `{ content }`
 * - 记忆上下文注入改为 `ctx.session.hook("context")`
 */
export default Plugin.define({
  id: "devcxl.opencode-memory",

  async setup(ctx) {
    const config = loadConfig(ctx.options as Record<string, unknown>);

    // remote 模式注入远程 Provider；local 模式由 MemoryManager 内部创建
    let providers: Providers | undefined;
    if (config.mode === "remote" && config.remote) {
      providers = await createProviders("remote", config);
    }

    const memoryManager = new MemoryManager(config, providers);
    const bootstrapManager = new BootstrapManager(memoryManager);
    const projects = new SessionProjectResolver(ctx);
    const sessionStates = new SessionStateStore();

    /** 引导阶段优先展示 BOOTSTRAP.md；常规阶段注入 MEMORY / IDENTITY / USER / PROJECT */
    const buildContext = async (projectId: string | null): Promise<string> => {
      const sections: string[] = [];

      if (bootstrapManager.isBootstrapNeeded()) {
        const bootstrapContent = await memoryManager.readFile(
          memoryManager.getBootstrapPath(),
        );
        if (bootstrapContent?.trim()) {
          sections.push(
            `## BOOTSTRAP.md (First Run Setup)\n\n${bootstrapContent.trim()}`,
          );
        }
      } else {
        const contextFiles = await memoryManager.getContextFiles(projectId);
        for (const file of contextFiles) {
          sections.push(`## ${file.name}\n\n${file.content}`);
        }
      }

      if (sections.length === 0) return "";
      return `# Memory Context\n\n${sections.join("\n\n---\n\n")}`;
    };

    // 静态指令，避免 {today} 之类动态内容导致 KV cache 失效
    const getMemoryInstructions = (): string =>
      bootstrapManager.isBootstrapNeeded()
        ? BOOTSTRAP_INSTRUCTIONS
        : getMemoryAwarenessInstructions();

    // 1. 命令：/memory-init
    await registerMemoryInitCommand(ctx, {
      memoryManager,
      bootstrapManager,
    });

    // 2. 工具：memory
    await registerMemoryTool(ctx, { memoryManager, projects });

    // 3. 工具执行后：记录本会话的 memory 操作，用于 daily 提醒
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "memory") return;
      const input = (event.input ?? {}) as MemoryCallInfo;
      sessionStates.record(
        event.sessionID,
        input,
        event.status === "completed",
      );
    });

    // 4. 模型请求前：注入记忆上下文与感知指令
    await ctx.session.hook("context", async (event) => {
      const projectId = await projects.resolve(event.sessionID);
      const memoryContext = await buildContext(projectId);
      const instructions = getMemoryInstructions();

      let text = memoryContext + instructions;

      // V2 的 server 端没有 V1 的 tui.showToast；
      // 改为在系统上下文中提醒模型补记 daily 日志。
      if (sessionStates.needsDailyReminder(event.sessionID)) {
        text += [
          "",
          "## Memory Reminder",
          "",
          "This session has performed memory operations but has not updated the daily log.",
          "Call memory with action 'write' and target 'daily' to record what happened.",
        ].join("\n");
      }

      if (!text.trim()) return;
      event.system.push({ type: "text", text });
    });

    // 5. 会话生命周期：注册/清理状态与项目缓存，并维持事件订阅
    const controller = new AbortController();

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.created", "session.deleted"] as const,
          signal: controller.signal,
        })) {
          if (event.type === "session.created") {
            sessionStates.get(event.data.sessionID);
            projects.setFromDirectory(
              event.data.sessionID,
              event.data.location.directory,
              event.data.subpath,
            );
          } else if (event.type === "session.deleted") {
            sessionStates.delete(event.data.sessionID);
            projects.delete(event.data.sessionID);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error(
          "[opencode-memory] Event subscription failed:",
          error instanceof Error ? error.message : error,
        );
      }
    })();

    return () => {
      controller.abort();
      sessionStates.clear();
      projects.clear();
    };
  },
});
