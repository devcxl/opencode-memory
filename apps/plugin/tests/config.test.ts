import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, resolveEnvRef } from "../src/config/runtime.js";

const ORIGINAL_ENV = { ...process.env };

describe("loadConfig（v2 纯远程模式）", () => {
  beforeEach(() => {
    delete process.env.OPM_API_URL;
    delete process.env.OPM_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("缺少 apiKey 时抛出可读错误", () => {
    expect(() => loadConfig()).toThrow(/API Token/);
  });

  test("环境变量提供 apiUrl/apiKey", () => {
    process.env.OPM_API_URL = "https://mem.example.com";
    process.env.OPM_API_KEY = "opm_test123";
    const config = loadConfig();
    expect(config.apiUrl).toBe("https://mem.example.com");
    expect(config.apiKey).toBe("opm_test123");
    expect(config.autoProject).toBe(true);
  });

  test("env:// 前缀引用环境变量", () => {
    process.env.OPM_API_KEY = "opm_from_env";
    expect(resolveEnvRef("env://OPM_API_KEY")).toBe("opm_from_env");
    expect(resolveEnvRef("opm_literal")).toBe("opm_literal");
    expect(resolveEnvRef(undefined)).toBeUndefined();
  });
});
