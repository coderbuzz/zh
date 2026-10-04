import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import { BigModelCodingPlanSubscriptionProvider } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import type { ICredentialService } from "../src/credential/credential.js";

interface Route {
  match: (url: string, init?: ApiRequestInit) => boolean;
  respond: (url: string, init?: ApiRequestInit) => unknown;
}

function createStubApiClient(routes: Route[]): { client: ApiClient; calls: Array<{
  url: string;
  init?: ApiRequestInit;
}> } {
  const calls: Array<{ url: string; init?: ApiRequestInit }> = [];
  return {
    calls,
    client: {
      request: async (input: string | URL, init?: ApiRequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init });
        const route = routes.find((candidate) => candidate.match(url, init));
        if (!route) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify(route.respond(url, init)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

function createStubCredentialService(store: Map<string, string>): ICredentialService {
  return {
    load: async (key) => store.get(key) ?? null,
    save: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

function createProvider(apiClient: ApiClient, credentials: ICredentialService) {
  return new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: credentials,
  });
}

const PREVIEW_URL_PREFIX = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview";
const CLAIM_URL_PREFIX = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";

test("getManualClaimPlanPreviews normalizes the snake_case envelope and appends client params", async () => {
  const { client, calls } = createStubApiClient([
    {
      match: (url) => url.startsWith(PREVIEW_URL_PREFIX),
      respond: () => ({
        code: 0,
        msg: "",
        data: {
          server_time: 1_700_000_000,
          plans: [
            {
              plan_id: "trust-build-100m",
              name: "ZCODE Trust Build",
              description: "Limited free quota",
              priority: 10,
              entitlements: [
                {
                  entitlement_id: "ent-1",
                  show_name: "GLM-5.3-Flash quota",
                  meter: "tokens",
                  unit_type: "TOKEN",
                  capabilities: ["model:glm-5.3-flash"],
                  grant_units: 100_000_000,
                  period: "P30D",
                  priority: 1,
                  effective_at: 1_700_000_000,
                },
              ],
            },
            { plan_id: "  ", name: "dropped", entitlements: [] },
          ],
        },
      }),
    },
  ]);
  const provider = createProvider(
    client,
    createStubCredentialService(new Map([["zcodejwttoken", "jwt-token"]])),
  );

  const previews = await provider.getManualClaimPlanPreviews();

  assert.deepEqual(previews, {
    serverTime: 1_700_000_000_000,
    plans: [
      {
        planId: "trust-build-100m",
        name: "ZCODE Trust Build",
        description: "Limited free quota",
        priority: 10,
        entitlements: [
          {
            entitlementId: "ent-1",
            showName: "GLM-5.3-Flash quota",
            meter: "tokens",
            unitType: "TOKEN",
            capabilities: ["model:glm-5.3-flash"],
            grantUnits: 100_000_000,
            period: "P30D",
            priority: 1,
            effectiveAt: 1_700_000_000,
          },
        ],
      },
    ],
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/v1/zcode-plan/billing/preview");
  assert.ok(url.searchParams.get("app_version"));
  assert.equal(url.searchParams.get("platform"), `${process.platform}-${process.arch}`);
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer jwt-token");
});

test("getManualClaimPlanPreviews omits the Authorization header without a token and fails on error envelopes", async () => {
  const { client, calls } = createStubApiClient([
    {
      match: (url) => url.startsWith(PREVIEW_URL_PREFIX),
      respond: () => ({ code: 0, data: { plans: [] } }),
    },
  ]);
  const provider = createProvider(client, createStubCredentialService(new Map()));
  const previews = await provider.getManualClaimPlanPreviews();
  assert.deepEqual(previews, { plans: [] });
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("Authorization"), null);

  const failing = createStubApiClient([
    {
      match: (url) => url.startsWith(PREVIEW_URL_PREFIX),
      respond: () => ({ code: 1001, msg: "offer ended" }),
    },
  ]);
  await assert.rejects(
    createProvider(failing.client, createStubCredentialService(new Map())).getManualClaimPlanPreviews(),
    /offer ended/,
  );
});

test("claimManualPlan sends plan_id, captcha headers, and parses the success envelope", async () => {
  const { client, calls } = createStubApiClient([
    {
      match: (url, init) => url.startsWith(CLAIM_URL_PREFIX) && init?.method === "POST",
      respond: (_url, init) => {
        assert.equal(init?.body, JSON.stringify({ plan_id: "trust-build-100m" }));
        return {
          code: 0,
          msg: "ok",
          data: {
            server_time: 1_700_000_001,
            plan: {
              user_plan_id: "up-1",
              plan_id: "trust-build-100m",
              status: "active",
              starts_at: 1_700_000_000,
              ends_at: 1_700_259_200,
              entitlements: [
                { entitlement_id: "ent-1", show_name: "GLM-5.3-Flash quota" },
                { entitlement_id: "  " },
              ],
            },
          },
        };
      },
    },
  ]);
  const provider = createProvider(
    client,
    createStubCredentialService(new Map([["zcodejwttoken", "jwt-token"]])),
  );

  const result = await provider.claimManualPlan({
    planId: "trust-build-100m",
    captchaVerifyParam: "verify-abc",
    captchaRegion: "sgp",
  });

  assert.deepEqual(result, {
    success: true,
    code: 0,
    message: "ok",
    serverTime: 1_700_000_001_000,
    plan: {
      userPlanId: "up-1",
      planId: "trust-build-100m",
      status: "active",
      startsAt: 1_700_000_000,
      endsAt: 1_700_259_200,
      entitlements: [
        { entitlementId: "ent-1", showName: "GLM-5.3-Flash quota" },
      ],
    },
  });
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer jwt-token");
  assert.equal(headers.get("X-Aliyun-Captcha-Verify-Param"), "verify-abc");
  assert.equal(headers.get("X-Aliyun-Captcha-Verify-Region"), "sgp");
  assert.ok(headers.get("X-ZCode-App-Version"));
  assert.equal(headers.get("X-Platform"), `${process.platform}-${process.arch}`);
});

test("claimManualPlan returns 401 without a token and folds business failures into the result", async () => {
  const noToken = createStubApiClient([]);
  const result401 = await createProvider(
    noToken.client,
    createStubCredentialService(new Map()),
  ).claimManualPlan({ planId: "p", captchaVerifyParam: "v" });
  assert.deepEqual(result401, { success: false, code: 401, message: "" });
  assert.equal(noToken.calls.length, 0);

  const failing = createStubApiClient([
    {
      match: (url) => url.startsWith(CLAIM_URL_PREFIX),
      respond: () => ({
        code: "1002",
        msg: "already claimed",
        data: { message: "Anda sudah klaim", plan: null, server_time: 1_700_000_000 },
      }),
    },
  ]);
  const result = await createProvider(
    failing.client,
    createStubCredentialService(new Map([["zcodejwttoken", "jwt-token"]])),
  ).claimManualPlan({ planId: "p" });
  assert.equal(result.success, false);
  assert.equal(result.code, 1002);
  assert.equal(result.message, "Anda sudah klaim");
  assert.equal(result.serverTime, 1_700_000_000_000);
  assert.equal(new Headers(failing.calls[0]!.init?.headers).get("X-Aliyun-Captcha-Verify-Param"), null);
});

test("getCaptchaConfig maps skip_model_request and returns null when absent", async () => {
  const withCaptcha = createStubApiClient([
    {
      match: (url) => url.includes("/api/v1/client/configs"),
      respond: () => ({
        code: 0,
        data: {
          configs: {
            captcha: {
              region: "sgp",
              prefix: "zcode",
              sceneId: "scene-1",
              mode: "popup",
              skip_model_request: true,
            },
          },
        },
      }),
    },
  ]);
  const config = await createProvider(
    withCaptcha.client,
    createStubCredentialService(new Map()),
  ).getCaptchaConfig();
  assert.deepEqual(config, {
    region: "sgp",
    prefix: "zcode",
    sceneId: "scene-1",
    mode: "popup",
    skipModelRequest: true,
  });

  const withoutCaptcha = createStubApiClient([
    {
      match: (url) => url.includes("/api/v1/client/configs"),
      respond: () => ({ code: 0, data: { configs: {} } }),
    },
  ]);
  assert.equal(
    await createProvider(
      withoutCaptcha.client,
      createStubCredentialService(new Map()),
    ).getCaptchaConfig(),
    null,
  );
});
