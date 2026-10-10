import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebBridgedCredentialStore } from "../src/web-account-bridge.js";

const setup = (settings: object, credentials: Record<string, string>) => {
  const base = mkdtempSync(join(tmpdir(), "zh-bridge-"));
  const dir = join(base, ".zcode", "v2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "setting.json"), JSON.stringify(settings));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify(credentials)); // plain values are accepted
  return createWebBridgedCredentialStore({ ZCODE_DATA_BASE_DIR: base });
};
const IND = "account-provider:account:zai-individual-coding-plan:identity";
const START = "account-provider:account:zai-start-plan:identity";
const profile = JSON.stringify({ user_id: "u-1" });

test("identity comes from the web profile when web is connected", async () => {
  const store = setup(
    { providerFamilyDomain: "zai", providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } } },
    { "oauth:zai:user_info": profile },
  );
  assert.equal(await store.load(IND), "u-1");
  assert.equal(await store.load(START), "u-1");
  assert.deepEqual(await store.loadMany([IND, "other"]), { [IND]: "u-1", other: null });
});

test("start plan needs only the connected family; individual needs its selection", async () => {
  const store = setup({ providerFamilyDomain: "zai", providerFamilyConnectionSelections: {} }, { "oauth:zai:user_info": profile });
  assert.equal(await store.load(START), "u-1");
  assert.equal(await store.load(IND), null);
});

test("no bridge when web is not connected, profile unreadable, or an identity already exists", async () => {
  assert.equal(await setup({ providerFamilyDomain: "bigmodel" }, { "oauth:zai:user_info": profile }).load(START), null);
  assert.equal(await setup({ providerFamilyDomain: "zai" }, { "oauth:zai:user_info": "{not json" }).load(START), null);
  assert.equal(await setup({ providerFamilyDomain: "zai" }, { [START]: "own", "oauth:zai:user_info": profile }).load(START), "own");
});
