import * as path from "node:path";
import * as fs from "node:fs";
import { isInitTemplateContent } from "./templates.js";

/** 检查 memory 系统的初始化状态，区分未初始化/引导中/就绪三种状态 */
export class StateChecker {
  constructor(private memoryDir: string) {}

  /** 检查 MEMORY.md 是否存在，作为系统是否初始化的基本标志 */
  isInitialized(): boolean {
    return fs.existsSync(path.join(this.memoryDir, "MEMORY.md"));
  }

  /** 检查 BOOTSTRAP.md 是否存在，判断是否处于引导流程中 */
  needsBootstrap(): boolean {
    return fs.existsSync(path.join(this.memoryDir, "BOOTSTRAP.md"));
  }

  /**
   * 推断当前初始化状态：
   * - "bootstrapping": 存在引导文件
   * - "uninitialized": 缺少关键文件或内容为空/为模板
   * - "ready": 所有文件存在且内容已填写
   *
   * 区分"未初始化"和"引导中"是为了让 AI 能选择不同的交互策略
   */
  getInitState(): "uninitialized" | "bootstrapping" | "ready" {
    const memoryPath = path.join(this.memoryDir, "MEMORY.md");
    const bootstrapPath = path.join(this.memoryDir, "BOOTSTRAP.md");
    const identityPath = path.join(this.memoryDir, "IDENTITY.md");
    const userPath = path.join(this.memoryDir, "USER.md");

    if (fs.existsSync(bootstrapPath)) {
      return "bootstrapping";
    }

    if (!fs.existsSync(memoryPath)) {
      return "uninitialized";
    }

    const memoryContent = this.readContent(memoryPath);
    if (!memoryContent?.trim() || isInitTemplateContent(memoryContent)) {
      return "uninitialized";
    }

    const identityContent = this.readContent(identityPath);
    const userContent = this.readContent(userPath);

    if (
      identityContent?.trim() &&
      userContent?.trim() &&
      !isInitTemplateContent(identityContent) &&
      !isInitTemplateContent(userContent)
    ) {
      return "ready";
    }

    return "uninitialized";
  }

  /** 安全读取文件内容，文件不存在返回 null */
  private readContent(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }
}
