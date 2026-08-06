import type { MemoryManager } from "../memory/MemoryManager.js";
import type { SearchScope } from "../types.js";
import { validateScope } from "../utils/validation.js";

/**
 * 在内存文件中进行语义搜索，返回按相关性评分排序的结果。
 * scope 控制搜索范围：project 限定当前项目，global 只搜全局，all 搜索全部。
 *
 * @param params - query、max_results、period、scope
 * @param memoryManager - MemoryManager 实例
 * @param projectId - 当前项目 ID（project scope 必需）
 * @returns 格式化搜索结果字符串
 */
export async function handleSearch(
  params: {
    query?: string;
    max_results?: number;
    period?: string;
    scope?: string;
  },
  memoryManager: MemoryManager,
  projectId: string | null,
): Promise<string> {
  const { query, max_results, period, scope } = params;

  if (!query) {
    return "Error: query is required for search action.";
  }

  if (scope) {
    validateScope(scope);
  }

  const searchScope = (scope ?? "all") as SearchScope;

  const effectiveProjectId =
    searchScope === "project"
      ? projectId
      : searchScope === "global"
        ? null
        : projectId;

  try {
    const scopeInfo =
      searchScope === "global"
        ? "[scope: global]"
        : searchScope === "project" && !projectId
          ? "[scope: global] (no project detected, fallback)"
          : projectId
            ? `[scope: project/${projectId}]`
            : "[scope: all]";

    const results = await memoryManager.semanticSearch(
      query,
      max_results ?? 20,
      period,
      searchScope === "project" ? projectId : effectiveProjectId,
      searchScope,
    );

    if (results.length === 0) {
      const periodMsg = period ? ` (filtered by period: ${period})` : "";
      return `${scopeInfo} No results for "${query}"${periodMsg}.`;
    }

    const output = results
      .map((r) => {
        const ts = r.timestamp ? `[${r.timestamp}]` : "[no timestamp]";
        const heading = r.heading ? ` (${r.heading})` : "";
        return `${ts} ${r.filePath}${heading}:${r.score.toFixed(4)}: ${r.text.slice(0, 200)}`;
      })
      .join("\n\n");

    const periodMsg = period ? ` (filtered by period: ${period})` : "";
    return `${scopeInfo} Found ${results.length} results${periodMsg}:\n\n${output}`;
  } catch (error) {
    throw error;
  }
}
