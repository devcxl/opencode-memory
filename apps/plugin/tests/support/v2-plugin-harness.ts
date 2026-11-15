/**
 * V2 插件测试夹具。
 *
 * 用一个最小的 fake Plugin.Context 驱动 `setup`，捕获注册的
 * tool / command / hook / event 订阅，供测试直接调用。
 */

export interface V2HarnessOptions {
  /** session.get 返回的目录，用于项目解析 */
  projectDirectory?: string;
  /** 插件 options */
  options?: Record<string, unknown>;
}

export interface V2Harness {
  /** 调用 memory 工具，返回 content 字符串 */
  executeMemory(
    args: Record<string, unknown>,
    sessionID?: string,
  ): Promise<string>;
  /** 触发 context hook，返回注入的 system 文本 */
  buildSystem(sessionID?: string): Promise<string>;
  /** 执行已注册的 memory-init 命令 */
  runMemoryInit(sessionID?: string, text?: string): Promise<void>;
  /** 触发 tool.execute.after */
  triggerToolAfter(
    tool: string,
    input: unknown,
    sessionID?: string,
    status?: "completed" | "error",
  ): Promise<void>;
  /** 注册的命令名 */
  commandNames(): string[];
  /** 已捕获的 memory 工具定义 */
  memoryTool(): any;
  /** 停止事件订阅并执行 cleanup */
  cleanup(): Promise<void>;
}

interface ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  execute: (input: any, context: any) => Promise<{ content?: string }>;
}

/**
 * 启动插件并返回测试夹具。
 * `plugin` 应传入 `import("../src/index.js").default`。
 */
export async function createV2Harness(
  plugin: {
    id: string;
    setup: (ctx: any) => Promise<(() => void) | void> | (() => void) | void;
  },
  options: V2HarnessOptions = {},
): Promise<V2Harness> {
  const projectDirectory = options.projectDirectory ?? "/tmp/test-project";
  const tools: ToolDefinition[] = [];
  const toolHooks: Record<string, (event: any) => unknown> = {};
  const sessionHooks: Record<string, (event: any) => unknown> = {};
  const commandDefs: Array<{ name: string; execute: (input: any) => any }> = [];

  const controller = new AbortController();

  const ctx: any = {
    options: options.options ?? {},
    app: { name: "opencode", version: "test", channel: "test" },
    location: {
      directory: projectDirectory,
      project: {
        id: "test-project",
        directory: projectDirectory,
        canonical: projectDirectory,
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    session: {
      get: async () => ({
        location: { directory: projectDirectory },
        subpath: undefined,
        projectID: "test-project",
      }),
      prompt: async () => {},
      hook: async (name: string, callback: (event: any) => unknown) => {
        sessionHooks[name] = callback;
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          list: () => tools,
          get: (name: string) => tools.find((tool) => tool.name === name),
          namespace: () => {},
          add: (tool: ToolDefinition) => tools.push(tool),
          update: () => {},
          remove: () => {},
        });
        return { dispose: async () => {} };
      },
      hook: async (name: string, callback: (event: any) => unknown) => {
        toolHooks[name] = callback;
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          add: (definition: any) => commandDefs.push(definition),
        });
        return { dispose: async () => {} };
      },
      list: async () => [],
      reload: async () => {},
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<{ done: boolean; value?: never }>((resolve) => {
              if (controller.signal.aborted) return resolve({ done: true });
              controller.signal.addEventListener(
                "abort",
                () => resolve({ done: true }),
                { once: true },
              );
            }),
        }),
      }),
    },
  };

  const cleanupFn = await plugin.setup(ctx);

  const stop = async () => {
    controller.abort();
    if (typeof cleanupFn === "function") {
      await cleanupFn();
    }
  };

  return {
    async executeMemory(args, sessionID = "test-session") {
      const tool = tools.find((candidate) => candidate.name === "memory");
      if (!tool) throw new Error("memory tool was not registered");
      const result = await tool.execute(args, {
        sessionID,
        agent: "build",
        messageID: "msg_test",
        id: "call_test",
        signal: new AbortController().signal,
        progress: async () => {},
      });
      return result?.content ?? "";
    },

    async buildSystem(sessionID = "test-session") {
      const hook = sessionHooks.context;
      if (!hook) throw new Error("context hook was not registered");
      const event = {
        sessionID,
        agent: "build",
        model: { providerID: "test", id: "test-model" },
        system: [] as Array<{ type: "text"; text: string }>,
        messages: [],
        options: {},
        tools: {},
      };
      await hook(event);
      return event.system.map((part) => part.text).join("\n");
    },

    async runMemoryInit(sessionID = "test-session", text = "") {
      const command = commandDefs.find(
        (definition) => definition.name === "memory-init",
      );
      if (!command) throw new Error("memory-init command was not registered");
      await command.execute({
        sessionID,
        prompt: { text },
        delivery: "steer",
      });
    },

    async triggerToolAfter(
      tool: string,
      input: unknown,
      sessionID = "test-session",
      status: "completed" | "error" = "completed",
    ) {
      const hook = toolHooks["execute.after"];
      if (!hook) throw new Error("execute.after hook was not registered");
      const event =
        status === "completed"
          ? {
              tool,
              input,
              sessionID,
              agent: "build",
              messageID: "msg_test",
              id: "call_test",
              status,
              result: { content: "" },
            }
          : {
              tool,
              input,
              sessionID,
              agent: "build",
              messageID: "msg_test",
              id: "call_test",
              status,
              error: { message: "failed" },
            };
      await hook(event);
    },

    commandNames() {
      return commandDefs.map((definition) => definition.name);
    },

    memoryTool() {
      return tools.find((candidate) => candidate.name === "memory");
    },

    cleanup: stop,
  };
}
