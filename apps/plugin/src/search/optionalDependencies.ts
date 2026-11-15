/**
 * 可选向量依赖的启动检查。
 *
 * `vectra` 与 `@huggingface/transformers` 在 package.json 中声明为
 * optionalDependencies：正常安装会装上，但 `--omit=optional`（以及
 * `--no-optional` / `--ignore-optional`）会静默跳过它们。缺少这两个包时搜索能力
 * 必然不可用，所以 setup 阶段统一报错，而不是等到首次搜索才抛出原始的
 * `Cannot find module`，也不静默禁用搜索。
 */

/** 一项可选依赖：包名，以及它为哪块能力服务 */
export interface OptionalDependency {
  /** npm 包名 */
  readonly name: string;
  /** 该依赖提供的运行时能力，用于错误信息 */
  readonly capability: string;
}

/** 语义搜索运行时必需的可选依赖 */
export const OPTIONAL_VECTOR_DEPENDENCIES: readonly OptionalDependency[] = [
  {
    name: "vectra",
    capability: "local vector index used by semantic search",
  },
  {
    name: "@huggingface/transformers",
    capability: "embedding model runtime used by semantic search",
  },
];

/** 依赖解析器：能解析视为已安装，抛错视为缺失 */
export type ModuleResolver = (specifier: string) => void;

/** 缺少可选向量依赖时抛出的统一错误 */
export class MissingOptionalDependenciesError extends Error {
  readonly code = "OPM_MISSING_OPTIONAL_DEPENDENCIES";

  constructor(readonly missing: readonly OptionalDependency[]) {
    super(formatMissingDependenciesMessage(missing));
    this.name = "MissingOptionalDependenciesError";
  }
}

function formatMissingDependenciesMessage(
  missing: readonly OptionalDependency[],
): string {
  const names = missing.map((dependency) => dependency.name).join(", ");
  const details = missing
    .map((dependency) => `  - ${dependency.name}: ${dependency.capability}`)
    .join("\n");

  return [
    `[opencode-memory] Missing required optional dependencies: ${names}`,
    "",
    "This plugin needs these packages for semantic search. They are declared as",
    "optionalDependencies, which package managers skip when an install uses",
    "--omit=optional, --no-optional or --ignore-optional.",
    "",
    details,
    "",
    "To fix, reinstall the plugin without omitting optional dependencies and",
    "restart OpenCode:",
    "  npm install -g @devcxl/opencode-memory@v2 --include=optional",
    "  # or, in the OpenCode plugin directory:",
    "  npm install @devcxl/opencode-memory@v2 --include=optional",
  ].join("\n");
}

/**
 * 默认解析器：用 `import.meta.resolve` 判断依赖是否可解析。
 *
 * 只解析、不加载，避免 setup 阶段就把 onnxruntime 之类的重型运行时拉起来；
 * 解析规则与后续的 `await import()` 一致，因此"能解析"等价于"用得到"。
 */
export function resolveInstalledModule(specifier: string): void {
  import.meta.resolve(specifier);
}

/** 返回当前缺失的可选依赖列表；全部可解析时返回空数组 */
export function findMissingOptionalDependencies(
  resolve: ModuleResolver = resolveInstalledModule,
): OptionalDependency[] {
  return OPTIONAL_VECTOR_DEPENDENCIES.filter((dependency) => {
    try {
      resolve(dependency.name);
      return false;
    } catch {
      return true;
    }
  });
}

/** 可选向量依赖缺失时抛出统一错误，否则静默返回 */
export function assertOptionalVectorDependencies(
  resolve: ModuleResolver = resolveInstalledModule,
): void {
  const missing = findMissingOptionalDependencies(resolve);
  if (missing.length === 0) return;
  throw new MissingOptionalDependenciesError(missing);
}
