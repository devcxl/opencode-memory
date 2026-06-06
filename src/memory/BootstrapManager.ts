import { MemoryManager } from "./MemoryManager.js";
import {
  BOOTSTRAP_TEMPLATE,
  IDENTITY_TEMPLATE,
  MEMORY_TEMPLATE,
  USER_TEMPLATE,
} from "./templates.js";

/** 管理首次运行的引导流程，负责创建模板文件和检查引导状态 */
export class BootstrapManager {
  private memoryManager: MemoryManager;

  constructor(memoryManager: MemoryManager) {
    this.memoryManager = memoryManager;
  }

  /**
   * 创建初始模板文件（BOOTSTRAP.md / MEMORY.md / IDENTITY.md / USER.md）
   * 只在文件不存在时写入，不覆盖已有内容
   */
  createInitTemplates(): void {
    this.memoryManager.ensureDirectories();

    const bootstrapPath = this.memoryManager.getBootstrapPath();
    const memoryPath = this.memoryManager.getMemoryPath();
    const identityPath = this.memoryManager.getIdentityPath();
    const userPath = this.memoryManager.getUserPath();

    if (!this.memoryManager.fileExists(bootstrapPath)) {
      this.memoryManager.writeFileSync(
        bootstrapPath,
        BOOTSTRAP_TEMPLATE(bootstrapPath),
      );
    }
    if (!this.memoryManager.fileExists(memoryPath)) {
      this.memoryManager.writeFileSync(memoryPath, MEMORY_TEMPLATE);
    }
    if (!this.memoryManager.fileExists(identityPath)) {
      this.memoryManager.writeFileSync(identityPath, IDENTITY_TEMPLATE);
    }
    if (!this.memoryManager.fileExists(userPath)) {
      this.memoryManager.writeFileSync(userPath, USER_TEMPLATE);
    }
  }

  /** 委托给 MemoryManager：判断是否需要首次引导 */
  isBootstrapNeeded(): boolean {
    return this.memoryManager.needsBootstrap();
  }
}
