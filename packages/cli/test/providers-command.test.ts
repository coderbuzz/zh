import assert from "node:assert/strict";
import test from "node:test";
import { buildProvidersCatalog } from "../src/providers-command.js";

const model = { properties: { contextWindow: 1000, inputFormat: { supportsText: true } }, optionSpecs: { reasoningLevel: { values: ["low", "high"] }, maxOutputTokens: { max: 99 } } };
const snapshot = {
  config: {
    zcodeBuiltinProviderTemplates: {
      entries: () => [
        ["openai", { templateId: "openai", templateNameMap: { "en-US": "OpenAI" }, config: { access: { type: "api-key" }, api: { type: "openai-responses", baseUrl: "u" }, builtinModelIds: ["gpt-x"] } }],
        ["deepseek", { templateId: "deepseek", templateNameMap: { "en-US": "DeepSeek" }, config: { builtinModelIds: [] } }],
      ] as never,
    },
    zcodeBuiltinModelRules: { resolve: () => model },
  },
  resolution: {
    resolvedProviders: [
      { providerId: "account:zai-individual-coding-plan", providerName: "Z", config: { access: { type: "zhipu-account", mode: "individual-coding-plan", entitled: false } }, models: [{ modelId: "GLM", config: model, executable: false }] },
      { providerId: "account:zai-offpeak", config: { visibility: "hidden", access: { type: "zhipu-account", mode: "off-peak" } }, models: [] },
      { providerId: "deepseek", templateId: "deepseek", providerName: "DeepSeek", config: { access: { type: "api-key", apiKey: "sk-SECRET" } }, models: [{ modelId: "ds-free", config: model, executable: true }, { modelId: "ds", config: model, executable: true }] },
    ],
  },
};

test("status, billing, template and no secret", () => {
  const out = buildProvidersCatalog(snapshot as never, new Date(0));
  const by = Object.fromEntries((out.providers as any[]).map((p) => [p.providerId, p]));
  assert.equal(by["account:zai-individual-coding-plan"].status, "needs-login");
  assert.equal(by["account:zai-individual-coding-plan"].models[0].billing, "plan");
  assert.equal(by["account:zai-offpeak"].status, "hidden");
  assert.equal(by.deepseek.status, "ready");
  assert.equal(by.deepseek.hasApiKey, true);
  assert.deepEqual(by.deepseek.models.map((m: any) => m.billing), ["free", "pay-as-you-go"]);
  assert.equal(by.openai.kind, "template");
  assert.equal(by.openai.status, "needs-api-key");
  assert.deepEqual(by.openai.models[0].thinkingLevels, ["low", "high"]);
  assert.equal(out.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.ok(!JSON.stringify(out).includes("SECRET"));
  assert.equal(by.deepseek.templateId, "deepseek"); // configured template is not duplicated
  assert.equal((out.providers as any[]).filter((p) => p.templateId === "deepseek").length, 1);
});
