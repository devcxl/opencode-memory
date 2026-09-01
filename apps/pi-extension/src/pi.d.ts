/**
 * pi coding agent 扩展 API 的最小类型声明。
 *
 * pi 官方文档（https://badlogic-pi-mono.mintlify.app/coding-agent/extensions）约定扩展通过
 * `import { pi } from "@mariozechner/pi-coding-agent"` 获取扩展 API，
 * 运行时由 pi 自身的模块解析注入，因此这里只需要类型面：
 * registerTool（工具注册）+ on("before_agent_start")（system prompt 注入）。
 * 若 pi 包名迁移（如 @earendil-works/pi-coding-agent），仅需修改本文件与本扩展的 import。
 */

declare module "@mariozechner/pi-coding-agent" {
  export interface ToolTextContent {
    type: "text";
    text: string;
  }

  /** pi.registerTool 的 execute 返回值 */
  export interface ToolResult {
    content: ToolTextContent[];
    isError?: boolean;
    details?: unknown;
  }

  /** 工具参数 schema：TypeBox / JSON Schema 对象 */
  export interface ToolDefinition<P = Record<string, unknown>> {
    name: string;
    label?: string;
    description: string;
    parameters: object;
    execute(
      toolCallId: string,
      params: P,
      signal: AbortSignal | undefined,
      onUpdate: (partial: unknown) => void,
      ctx: unknown,
    ): Promise<ToolResult>;
  }

  export interface BeforeAgentStartEvent {
    systemPrompt: string;
    [key: string]: unknown;
  }

  export type BeforeAgentStartResult = { systemPrompt?: string } | void;

  export interface PiExtensionAPI {
    registerTool<P = Record<string, unknown>>(tool: ToolDefinition<P>): void;
    on(
      event: "before_agent_start",
      handler: (
        event: BeforeAgentStartEvent,
        ctx: unknown,
      ) => Promise<BeforeAgentStartResult> | BeforeAgentStartResult,
    ): void;
    on(event: string, handler: (event: never, ctx: unknown) => unknown): void;
  }

  export const pi: PiExtensionAPI;
}
