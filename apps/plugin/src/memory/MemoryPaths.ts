import * as path from "node:path";

/**
 * 从 memoryDir 派生所有 memory 相关目录与文件路径。
 * 集中管理路径规则，避免业务 Module 重复拼接。
 */
export class MemoryPaths {
  readonly memoryDir: string;
  readonly dailyDir: string;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
    this.dailyDir = path.join(memoryDir, "daily");
  }

  get memoryPath(): string {
    return path.join(this.memoryDir, "MEMORY.md");
  }

  get identityPath(): string {
    return path.join(this.memoryDir, "IDENTITY.md");
  }

  get userPath(): string {
    return path.join(this.memoryDir, "USER.md");
  }

  get bootstrapPath(): string {
    return path.join(this.memoryDir, "BOOTSTRAP.md");
  }

  dailyPath(date: string): string {
    return path.join(this.dailyDir, `${date}.md`);
  }

  get projectsDir(): string {
    return path.join(this.memoryDir, "projects");
  }

  projectDir(projectId: string): string {
    return path.join(this.memoryDir, "projects", projectId);
  }

  projectMemoryPath(projectId: string): string {
    return path.join(this.projectDir(projectId), "MEMORY.md");
  }

  /** 获取项目级 daily 日志路径 */
  projectDailyPath(projectId: string, date: string): string {
    return path.join(this.projectDir(projectId), "daily", `${date}.md`);
  }

  get rootIndexPath(): string {
    return path.join(this.memoryDir, "root.index");
  }

  get dailyIndexPath(): string {
    return path.join(this.memoryDir, "daily.index");
  }
}
