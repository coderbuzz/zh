import assert from "node:assert/strict";
import test from "node:test";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type ApiClient,
  type ApiRequestInit,
} from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import { createZaiProviderRuntimeConfig } from "../src/oauth/providers/zaiProviderConfig.js";

const BASE_MS = 1_700_000_000_000;

// 服务端 init 返回的 authorize_url 携带官方 CLI callback；
// 该 callback 是后端把 flow 标记为 ready 的唯一入口，必须原样透传给浏览器。
const ZAI_AUTHORIZE_URL =
  "https://chat.z.ai/api/oauth/authorize" +
  "?redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fzai" +
  "&response_type=code&client_id=client_test&state=srv-zai-state&code_challenge=abc";
const BIGMODEL_AUTHORIZE_URL =
  "https://bigmodel.cn/login" +
  "?redirect=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel" +
  "&client_id=zcode&state=srv-bigmodel-state";

interface Route {
  match: (url: string) => boolean;
  respond: () => unknown;
}

function createStubApiClient(routes: Route[]): ApiClient {
  return {
    request: async (input: string | URL, _init?: ApiRequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const route = routes.find((candidate) => candidate.match(url));
      if (!route) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(route.respond()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function createStubCredentialService(): ICredentialService {
  const store = new Map<string, string>();
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

function createInitEnvelope(authorizeUrl: string): unknown {
  return {
    code: 0,
    data: {
      flow_id: "flow-1",
      authorize_url: authorizeUrl,
      expires_at: BASE_MS / 1000 + 300,
      poll_interval_sec: 1,
    },
  };
}

test("polling start returns the server-provided Z.AI authorize URL unchanged", async () => {
  const apiClient = createStubApiClient([
    { match: (url) => url.includes("/api/v1/oauth/cli/init"), respond: () => createInitEnvelope(ZAI_AUTHORIZE_URL) },
  ]);
  const service = new OAuthService(createStubCredentialService(), {
    apiClient,
    env: {},
    now: () => BASE_MS,
  });

  const start = await service.startOAuthWithPolling(ZAI_PROVIDER_ID);

  assert.equal(start.authorizeUrl, ZAI_AUTHORIZE_URL);
  assert.ok(!start.authorizeUrl.includes("/app/oauth/login"));
  assert.ok(!start.authorizeUrl.includes("zcode://"));
  // state 必须继续取自服务端 URL，flow 校验与轮询都依赖它。
  assert.equal(new URL(start.authorizeUrl).searchParams.get("state"), "srv-zai-state");
  assert.equal(start.state, "srv-zai-state");

  await service.cancelPending();
});

test("polling start returns the server-provided BigModel authorize URL unchanged", async () => {
  const apiClient = createStubApiClient([
    {
      match: (url) => url.includes("/api/v1/oauth/cli/init"),
      respond: () => createInitEnvelope(BIGMODEL_AUTHORIZE_URL),
    },
  ]);
  const service = new OAuthService(createStubCredentialService(), {
    apiClient,
    env: {},
    now: () => BASE_MS,
  });

  const start = await service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);

  assert.equal(start.authorizeUrl, BIGMODEL_AUTHORIZE_URL);
  assert.ok(!start.authorizeUrl.includes("/app/oauth/login"));
  assert.ok(!start.authorizeUrl.includes("zcode://"));

  await service.cancelPending();
});

test("polling resolves to a logged-in session once the official callback completes the flow", async () => {
  let pollCalls = 0;
  const apiClient = createStubApiClient([
    {
      match: (url) => url.includes("/api/v1/oauth/cli/init"),
      respond: () => createInitEnvelope(ZAI_AUTHORIZE_URL),
    },
    {
      match: (url) => url.includes("/api/v1/oauth/cli/poll/"),
      respond: () => {
        pollCalls += 1;
        if (pollCalls === 1) {
          return { code: 0, data: { status: "pending" } };
        }
        return {
          code: 0,
          data: {
            status: "ready",
            token: "zcode-jwt",
            zai: { access_token: "zai-oauth-token" },
            user: { user_id: "u1", name: "Ayu" },
          },
        };
      },
    },
    {
      // normalizePolledTokenSet 用 OAuth token 换业务 token；stub 直接放行。
      match: (url) => url.includes("/api/auth/z/login"),
      respond: () => ({ code: 0, data: { access_token: "zai-business-token", expires_in: 3600 } }),
    },
  ]);
  let currentMs = BASE_MS;
  const service = new OAuthService(createStubCredentialService(), {
    apiClient,
    env: {},
    now: () => currentMs,
  });

  await service.startOAuthWithPolling(ZAI_PROVIDER_ID);

  const pending = await service.pollPendingOAuth();
  assert.equal(pending, null);

  currentMs += 2_000;
  const result = await service.pollPendingOAuth();
  assert.ok(result && result.kind === "session");
  assert.equal(result.provider, ZAI_PROVIDER_ID);
  assert.equal(result.userInfo.id, "u1");
  assert.equal(result.userInfo.username, "Ayu");
  assert.equal(await service.getActiveProvider(), ZAI_PROVIDER_ID);
});

test("desktop deep-link redirect contract stays intact for the legacy non-polling flow", () => {
  const config = createZaiProviderRuntimeConfig({});
  assert.ok(config.redirectUri.includes("/app/oauth/login"));
  assert.ok(config.redirectUri.includes(encodeURIComponent("zcode://oauth/callback")));
});
