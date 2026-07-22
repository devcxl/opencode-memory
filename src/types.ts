/** 内存文件目标类型 */
export type MemoryTarget =
  "memory" | "identity" | "user" | "daily" | "bootstrap";
/** 写入模式 */
export type WriteMode = "append" | "overwrite";
/** 内存操作类型 */
export type MemoryAction =
  "read" | "write" | "edit" | "delete" | "search" | "list";
/** 搜索范围 */
export type SearchScope = "all" | "global" | "project";

/** 带时间戳的条目 */
export interface TimestampEntry {
  timestamp: string;
  content: string;
}

/** 语义搜索结果 */
export interface SemanticSearchResult {
  score: number;
  filePath: string;
  heading: string;
  text: string;
  timestamp?: string;
}

/** 月度文件分组 */
export interface MonthGroup {
  month: string;
  fileCount: number;
  entryCount: number;
  files: Array<{ name: string; timestamps: string[] }>;
}

/** 搜索结果 */
export interface SearchResult {
  file: string;
  line: number;
  text: string;
}

/** 列表结果 */
export interface ListResult {
  root: string[];
  daily: string[];
}

/** 上下文文件 */
export interface ContextFile {
  name: string;
  content: string;
}
