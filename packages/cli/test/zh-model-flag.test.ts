import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelFlag, type ModelFlagRegistryView } from "../src/zh-model-flag.js";

const levels = (values: string[]) => ({ optionSpecs: { reasoningLevel: { values } } });
const registry: ModelFlagRegistryView = {
  providers: [
    { providerId: "glm", models: [{ modelId: "glm-5.3", config: levels(["low", "high", "max"]) }] },
    { providerId: "deepseek", models: [{ modelId: "deepseek-v4", config: levels(["disabled", "low", "high", "max"]) }] },
  ],
};
const run = (input: { model?: string; effort?: string; configuredDefault?: { providerId: string; modelId: string } }) =>
  resolveModelFlag({ ...input, registry });

test("no flags: undefined (old behaviour)", () => assert.equal(run({}), undefined));

test("valid model with level in the string", () =>
  assert.deepEqual(run({ model: "deepseek/deepseek-v4$low" }), {
    providerId: "deepseek", modelId: "deepseek-v4", options: { reasoningLevel: "low" },
  }));

test("--effort overrides the $level and valid model without level takes highest", () => {
  assert.equal(run({ model: "deepseek/deepseek-v4$low", effort: "high" })?.options?.reasoningLevel, "high");
  assert.equal(run({ model: "glm/glm-5.3" })?.options?.reasoningLevel, "max");
});

test("unknown provider / model / bad format", () => {
  assert.throws(() => run({ model: "nope/x" }), /Unknown provider "nope".*glm, deepseek/);
  assert.throws(() => run({ model: "glm/nope" }), /Unknown model "nope".*glm-5.3/);
  assert.throws(() => run({ model: "glm-5.3" }), /--model must look like/);
});

test("level invalid for that model", () => {
  assert.throws(() => run({ model: "glm/glm-5.3", effort: "disabled" }), /Unsupported effort "disabled".*low, high, max/);
  assert.throws(() => run({ model: "glm/glm-5.3$xhigh" }), /Unsupported effort "xhigh"/);
});

test("--effort alone: configured default, else first model", () => {
  assert.deepEqual(run({ effort: "low", configuredDefault: { providerId: "deepseek", modelId: "deepseek-v4" } }), {
    providerId: "deepseek", modelId: "deepseek-v4", options: { reasoningLevel: "low" },
  });
  assert.equal(run({ effort: "high" })?.providerId, "glm");
  assert.throws(() => resolveModelFlag({ effort: "low", registry: { providers: [] } }), /--effort needs a model/);
  assert.throws(() => run({ effort: "disabled" }), /Unsupported effort "disabled"/);
});
