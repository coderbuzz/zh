import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";
import { ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV } from "@zcode/provider-node";
import { createWebBridgedCredentialStore } from "./web-account-bridge.js";
import { loadBootstrapModule } from "./bootstrap-loader.js";

/**
 * `zh providers`: one-shot, read-only JSON catalogue of every provider/model the
 * registry knows (account plans, API-key providers, unconfigured templates), for
 * orchestrators that need valid `--model`/`--effort` values. It never prints a
 * secret (only `hasApiKey`), never refreshes credentials, and skips the built-in
 * catalogue download by starting the registry without the bundled-config env.
 */
export interface ProvidersFlags {
  provider?: string;
  model?: string;
  availableOnly: boolean;
}

type Billing = "plan" | "free" | "idle-quota" | "pay-as-you-go" | "unknown";

// Structural views of the provider registry snapshot; avoids a package dependency.
interface ModelCfg {
  properties?: {
    contextWindow?: number;
    inputFormat?: Record<string, boolean | undefined>;
    supportsToolCall?: boolean;
  };
  optionSpecs?: {
    reasoningLevel?: { values?: readonly string[] };
    maxOutputTokens?: { max?: number } | null;
  };
}
interface ProviderCfg {
  access?: { type?: string; mode?: string; accountType?: string; entitled?: boolean; apiKey?: string };
  api?: { type?: string; baseUrl?: string };
  visibility?: string | null;
  group?: string;
  builtinModelIds?: readonly string[];
}
interface ResolvedProviderView {
  providerId: string;
  providerName?: string;
  templateId?: string;
  config: ProviderCfg;
  models: readonly { modelId: string; config: ModelCfg; executable: boolean }[];
}
interface TemplateView {
  templateId: string;
  templateNameMap: Record<string, string>;
  config: ProviderCfg;
}
interface SnapshotView {
  config: {
    zcodeBuiltinProviderTemplates: { entries(): ReadonlyArray<readonly [string, TemplateView]> };
    zcodeBuiltinModelRules: {
      resolve(input: Record<string, unknown>): ModelCfg;
    };
  };
  resolution: { resolvedProviders: readonly ResolvedProviderView[] };
}

const accountBilling = (mode: string | undefined): Billing =>
  mode === "individual-coding-plan" || mode === "team-coding-plan"
    ? "plan"
    : mode === "off-peak"
      ? "idle-quota"
      // start-plan: source shows entitlement balances but nothing that proves it is free.
      : "unknown";

const providerBilling = (access: ProviderCfg["access"]): Billing => {
  if (access?.type === "zhipu-account") return accountBilling(access.mode);
  if (access?.type === "zhipu-coding-plan-api-key") return "plan";
  if (access?.type === "api-key") return "pay-as-you-go";
  return "unknown";
};

const modelEntry = (modelId: string, cfg: ModelCfg, billing: Billing, available: boolean) => {
  const input = cfg.properties?.inputFormat ?? {};
  return {
    modelId,
    available,
    thinkingLevels: [...(cfg.optionSpecs?.reasoningLevel?.values ?? [])],
    contextWindow: cfg.properties?.contextWindow ?? null,
    maxOutputTokens: cfg.optionSpecs?.maxOutputTokens?.max ?? null,
    input: {
      text: input.supportsText === true,
      image: input.supportsImage === true,
      video: input.supportsVideo === true,
      audio: input.supportsAudio === true,
      pdf: input.supportsPdf === true,
    },
    supportsToolCall: cfg.properties?.supportsToolCall ?? null,
    billing: /-free$/i.test(modelId) ? "free" : billing,
  };
};

export const buildProvidersCatalog = (snapshot: SnapshotView, now = new Date()) => {
  const providers: unknown[] = [];
  const configuredTemplates = new Set<string>();
  for (const p of snapshot.resolution.resolvedProviders) {
    const access = p.config.access;
    const isAccount = access?.type === "zhipu-account";
    const hasApiKey = typeof access?.apiKey === "string" && access.apiKey.trim() !== "";
    const ready = p.models.some((m) => m.executable);
    if (p.templateId) configuredTemplates.add(p.templateId);
    const status = ready
      ? "ready"
      : p.config.visibility === "hidden"
        ? "hidden"
        : isAccount
          ? "needs-login"
          : "needs-api-key";
    const billing = providerBilling(access);
    providers.push({
      providerId: p.providerId,
      name: p.providerName ?? p.providerId,
      kind: isAccount ? "account" : "api-key",
      ...(p.templateId ? { templateId: p.templateId } : {}),
      status,
      ...(isAccount ? { accountType: access?.accountType, mode: access?.mode } : { hasApiKey }),
      api: { type: p.config.api?.type ?? null, baseUrl: p.config.api?.baseUrl ?? null },
      models: p.models.map((m) => modelEntry(m.modelId, m.config, billing, m.executable)),
    });
  }
  const rules = snapshot.config.zcodeBuiltinModelRules;
  for (const [templateId, t] of snapshot.config.zcodeBuiltinProviderTemplates.entries()) {
    if (configuredTemplates.has(templateId)) continue;
    const billing = providerBilling(t.config.access);
    providers.push({
      providerId: templateId,
      name: t.templateNameMap["en-US"] ?? Object.values(t.templateNameMap)[0] ?? templateId,
      kind: "template",
      templateId,
      status: "needs-api-key",
      hasApiKey: false,
      api: { type: t.config.api?.type ?? null, baseUrl: t.config.api?.baseUrl ?? null },
      models: (t.config.builtinModelIds ?? []).map((modelId) =>
        modelEntry(
          modelId,
          rules.resolve({
            providerId: templateId,
            templateId,
            modelId,
            apiType: t.config.api?.type,
            baseUrl: t.config.api?.baseUrl,
          }),
          billing,
          false,
        ),
      ),
    });
  }
  return { schemaVersion: 1, generatedAt: now.toISOString(), providers };
};

export const runProvidersCommand = async (
  ctx: RunContext,
  _options: GlobalOptions,
  _deps: RunDependencies,
  args: string[],
  flags: ProvidersFlags,
): Promise<number> => {
  if (args.length > 0 && args[0] !== "list") {
    ctx.stderr.write("Usage: zh providers [list] [--provider <id>] [--model <id>] [--available-only]\n");
    return 1;
  }
  // No bundled-config env = no remote built-in refresh (no network, no cache write).
  const env: Record<string, string | undefined> = { ...process.env };
  delete env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV];
  let runtime: Awaited<
    ReturnType<(typeof import("@zcode/bootstrap"))["startProcessProviderRegistryRuntime"]>
  > | undefined;
  try {
    const boot = await loadBootstrapModule();
    runtime = await boot.startProcessProviderRegistryRuntime(env, {
      standalone: { credentialStore: createWebBridgedCredentialStore(env) },
    });
    const snapshot = runtime.runtime.registryService.getSnapshot() as unknown as SnapshotView;
    const catalog = buildProvidersCatalog(snapshot);
    const wantModel = flags.model?.toLowerCase();
    const providers = (catalog.providers as Array<Record<string, any>>)
      .filter(
        (p) =>
          (!flags.provider || p.providerId === flags.provider || p.templateId === flags.provider) &&
          (!flags.availableOnly || p.status === "ready"),
      )
      .map((p) => ({
        ...p,
        models: (p.models as Array<Record<string, any>>).filter(
          (m) =>
            (!wantModel || String(m.modelId).toLowerCase() === wantModel) &&
            (!flags.availableOnly || m.available === true),
        ),
      }))
      .filter((p) => !wantModel || p.models.length > 0);
    ctx.stdout.write(`${JSON.stringify({ ...catalog, providers }, null, 2)}\n`);
    return 0;
  } catch (error) {
    ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    runtime?.dispose();
  }
};
