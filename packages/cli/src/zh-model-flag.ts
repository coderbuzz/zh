import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";

/** Structural slice of the provider registry view; avoids a new package dependency. */
export interface ModelFlagRegistryView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly config?: { readonly visibility?: string | null };
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: { readonly reasoningLevel: { readonly values: readonly string[] } };
      };
    }[];
  }[];
}

/**
 * Turn `--model provider/model[$level]` and `--effort level` into a complete,
 * registry-validated ModelSelection, so a bad value fails at start instead of
 * mid-run. Returns undefined when neither flag is given (behaviour unchanged).
 * Without a level the model's highest level is used, like the interactive picker.
 */
export function resolveModelFlag(input: {
  model?: string;
  effort?: string;
  registry: ModelFlagRegistryView;
  configuredDefault?: ModelSelection;
}): ModelSelection | undefined {
  const { model, effort, registry } = input;
  if (model === undefined && effort === undefined) return undefined;

  let requested: ModelSelection;
  if (model !== undefined) {
    try {
      requested = parseModelPickerValue(model);
    } catch {
      throw new Error(`--model must look like provider/model or provider/model$level (received: ${model}).`);
    }
  } else {
    const base = input.configuredDefault ?? firstVisibleModel(registry);
    if (!base) throw new Error("--effort needs a model: pass --model, or configure a default model.");
    requested = { providerId: base.providerId, modelId: base.modelId };
  }

  const provider = registry.providers.find((p) => p.providerId === requested.providerId);
  if (!provider) {
    const known = registry.providers.map((p) => p.providerId).join(", ") || "none";
    throw new Error(`Unknown provider "${requested.providerId}" in --model (available: ${known}).`);
  }
  const found = provider.models.find((m) => m.modelId === requested.modelId);
  if (!found) {
    const known = provider.models.map((m) => m.modelId).join(", ") || "none";
    throw new Error(`Unknown model "${requested.modelId}" for provider "${provider.providerId}" (available: ${known}).`);
  }

  const levels = found.config.optionSpecs.reasoningLevel.values;
  const reasoningLevel = effort ?? requested.options?.reasoningLevel ?? levels.at(-1);
  if (!reasoningLevel || !levels.includes(reasoningLevel)) {
    throw new Error(
      `Unsupported effort "${reasoningLevel ?? ""}" for ${provider.providerId}/${found.modelId} (supported: ${levels.join(", ") || "none"}).`,
    );
  }
  return {
    providerId: provider.providerId,
    modelId: found.modelId,
    options: { reasoningLevel },
  };
}

function firstVisibleModel(registry: ModelFlagRegistryView): ModelSelection | undefined {
  for (const provider of registry.providers) {
    if (provider.config?.visibility === "hidden") continue;
    const model = provider.models[0];
    if (model) return { providerId: provider.providerId, modelId: model.modelId };
  }
  return undefined;
}
