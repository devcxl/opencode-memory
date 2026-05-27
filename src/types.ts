export interface MemoryConfig {
  memoryDir: string;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  memoryDir: "",
};

export type MemoryTarget =
  | "memory"
  | "identity"
  | "user"
  | "daily"
  | "bootstrap";
export type WriteMode = "append" | "overwrite";
export type MemoryAction =
  | "read"
  | "write"
  | "edit"
  | "delete"
  | "search"
  | "list";
export type SearchScope = "all" | "global" | "project";

export interface TimestampEntry {
  timestamp: string;
  content: string;
}

export interface SemanticSearchResult {
  score: number;
  filePath: string;
  heading: string;
  text: string;
  timestamp?: string;
}

export interface MonthGroup {
  month: string;
  fileCount: number;
  entryCount: number;
  files: Array<{ name: string; timestamps: string[] }>;
}

export function isValidTimestamp(value: string): boolean {
  const fullRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  return fullRegex.test(value) || dateRegex.test(value);
}

export interface SearchResult {
  file: string;
  line: number;
  text: string;
}

export interface ListResult {
  root: string[];
  daily: string[];
}

export interface ContextFile {
  name: string;
  content: string;
}
