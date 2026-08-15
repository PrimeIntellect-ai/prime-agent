import { describe, it, expect } from "vitest";
import { getModel } from "../src/models";

describe("aiand provider", () => {
  it("should resolve aiand models", () => {
    const model = getModel("aiand", "deepseek-ai/deepseek-v4-flash");
    expect(model).toBeDefined();
    expect(model.provider).toBe("aiand");
  });

  it("should have correct pricing for deepseek-v4-flash", () => {
    const model = getModel("aiand", "deepseek-ai/deepseek-v4-flash");
    expect(model.cost.input).toBe(0.15);
    expect(model.cost.output).toBe(0.25);
    expect(model.cost.cachedInput).toBe(0.08);
  });

  it("should have correct context window", () => {
    const model = getModel("aiand", "deepseek-ai/deepseek-v4-flash");
    expect(model.contextWindow).toBe(1000000);
  });

  it("should support tools", () => {
    const model = getModel("aiand", "deepseek-ai/deepseek-v4-flash");
    expect(model.supportsTools).toBe(true);
  });
});