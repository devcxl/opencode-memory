import { expect, test } from "bun:test";
import DefaultMemoryPlugin, { createMemoryPlugin } from "../src/index.js";
import {
  MissingOptionalDependenciesError,
  OPTIONAL_VECTOR_DEPENDENCIES,
  assertOptionalVectorDependencies,
  type ModuleResolver,
} from "../src/search/optionalDependencies.js";
import packageJson from "../package.json";
import { withTempHome } from "./support/temp-home.js";
import { createV2Harness } from "./support/v2-plugin-harness.js";

const VECTRA = "vectra";
const TRANSFORMERS = "@huggingface/transformers";

/**
 * 构造一个模拟"依赖缺失"的解析器：命中名单的包视为解析失败，
 * 与真实 `import.meta.resolve` 抛错等价（只是不依赖磁盘状态）。
 */
function resolverMissingDependency(...missingNames: string[]): ModuleResolver {
  const missing = new Set(missingNames);
  return (specifier) => {
    if (missing.has(specifier)) {
      throw new Error(`Cannot find module '${specifier}'`);
    }
  };
}

/** 捕获同步抛出的错误，便于继续断言错误内容 */
function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

test("both optional dependencies missing produce one actionable error", () => {
  const error = captureError(() =>
    assertOptionalVectorDependencies(
      resolverMissingDependency(VECTRA, TRANSFORMERS),
    ),
  );

  expect(error).toBeInstanceOf(MissingOptionalDependenciesError);
  expect(error.message).toContain(VECTRA);
  expect(error.message).toContain(TRANSFORMERS);
  // 修复建议：重新安装且不要跳过 optional 依赖
  expect(error.message).toContain("reinstall");
  expect(error.message).toContain("--omit=optional");
  // 不允许只把原始模块解析错误透传给用户
  expect(error.message).not.toContain("Cannot find module");
});

test("error names only the dependency that is actually missing", () => {
  const error = captureError(() =>
    assertOptionalVectorDependencies(resolverMissingDependency(VECTRA)),
  );

  expect(error.message).toContain(VECTRA);
  expect(error.message).not.toContain(TRANSFORMERS);
});

test("no error is raised when every optional dependency resolves", () => {
  expect(() => assertOptionalVectorDependencies(() => {})).not.toThrow();
});

test("the default resolver accepts the dependencies of a normal install", () => {
  expect(() => assertOptionalVectorDependencies()).not.toThrow();
});

test("plugin setup fails fast when an optional dependency is missing", async () => {
  const plugin = createMemoryPlugin(resolverMissingDependency(VECTRA));

  const error = await createV2Harness(plugin, { options: {} }).catch(
    (caught: Error) => caught,
  );

  expect(error).toBeInstanceOf(MissingOptionalDependenciesError);
  expect(error.message).toContain(VECTRA);
});

test("a normal install still registers the memory tool and /memory-init", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(DefaultMemoryPlugin, { options: {} });

    expect(harness.memoryTool()).toBeDefined();
    expect(harness.commandNames()).toContain("memory-init");

    await harness.cleanup();
  });
});

test("the dependency list matches the package optionalDependencies", () => {
  const declared = new Set(Object.keys(packageJson.optionalDependencies ?? {}));

  for (const dependency of OPTIONAL_VECTOR_DEPENDENCIES) {
    expect(declared.has(dependency.name)).toBe(true);
  }
});
