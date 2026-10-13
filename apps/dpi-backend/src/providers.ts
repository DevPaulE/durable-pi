// Which model provider a device runs, and how each one is registered.
//
// Faux stays the default for offline work. Every other provider is explicit:
// `DPI_PROVIDER` must name one of these, and anything else is refused instead of
// silently becoming OpenRouter. Credentials are never read here — pi-ai resolves
// them from the environment (OPENROUTER_API_KEY, RADIUS_API_KEY, OLLAMA_API_KEY),
// which `~/.dpi/backend.env` supplies through dpi-network.yaml `env_keys`.
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import type { ModelInfo } from "../../dpi-sdk/src/api.js";
import { curatedModels, defaultModelId } from "./model-catalog.js";
import { fauxModels, installFaux } from "./faux.js";

export type ProviderId = "faux" | "openrouter" | "radius" | "ollama";

export const PROVIDER_IDS = ["faux", "openrouter", "radius", "ollama"] as const satisfies readonly ProviderId[];

export const isProviderId = (value: string): value is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(value);

/** Parse a provider name, refusing anything unknown. */
export function parseProvider(value: string, where = "DPI_PROVIDER"): ProviderId {
  if (!isProviderId(value))
    throw Error(`${where} must be one of ${PROVIDER_IDS.join(", ")} — got "${value}". Nothing is picked for you.`);
  return value;
}

/**
 * Which providers a device registers, in order. `defaultProvider` comes first and Faux is always
 * registered: without it, a stored Faux session would be silently re-pointed at a paid provider
 * when the device's default changes. Unknown names are refused wherever they appear.
 */
export function parseProviders(value: string | undefined, defaultProvider: ProviderId, where = "DPI_PROVIDERS"): ProviderId[] {
  const named = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseProvider(part, where));
  const ordered = [defaultProvider, ...named, "faux" as ProviderId];
  return [...new Set(ordered)];
}

/** Ollama Cloud serves an OpenAI-compatible subset; cloud models need no local download. */
export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com/v1";
/** The cloud catalog endpoint does not report a context window; this is a floor, not a measurement. */
export const OLLAMA_ASSUMED_CONTEXT_WINDOW = 32768;

export const ollamaBaseUrl = (env: NodeJS.ProcessEnv = process.env) =>
  (env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");

type OllamaListResponse = { data?: { id?: unknown }[] };

/** Read the model catalog from an OpenAI-compatible `/models` endpoint. */
export async function fetchOllamaModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Model<"openai-completions">[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw Error(`Ollama catalog failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as OllamaListResponse;
  const ids = (body.data ?? []).flatMap((entry) => (typeof entry?.id === "string" && entry.id.trim() ? [entry.id.trim()] : []));
  if (!ids.length) throw Error(`Ollama catalog at ${baseUrl} returned no models`);
  return ids.map((id) => ({
    id,
    name: id,
    api: "openai-completions" as const,
    provider: "ollama",
    baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: OLLAMA_ASSUMED_CONTEXT_WINDOW,
    maxTokens: OLLAMA_ASSUMED_CONTEXT_WINDOW,
  }));
}

/** A dynamic provider: with a key the catalog comes from the endpoint, without one it stays empty. */
export function ollamaProvider(baseUrl: string = ollamaBaseUrl()) {
  return createProvider({
    id: "ollama",
    name: "Ollama Cloud",
    baseUrl,
    auth: { apiKey: envApiKeyAuth("Ollama API key", ["OLLAMA_API_KEY"]) },
    models: [],
    api: openAICompletionsApi(),
    fetchModels: async (context) => {
      const credential = context.credential;
      const key = credential?.type === "oauth" ? credential.access : credential?.key;
      if (!context.allowNetwork || context.signal.aborted || !key) return [];
      return fetchOllamaModels(baseUrl, key, context.signal);
    },
  });
}

/** Register every provider a device offers, in order. Unknown ids are refused, never defaulted. */
export function registerProviders(models: MutableModels, providerIds: readonly ProviderId[], options: { ollamaBaseUrl?: string } = {}): void {
  // Faux is always registered even when a remote provider is enabled. Existing sessions keep their
  // stored provider/model and a new remote provider must never silently replace a Faux session.
  for (const id of new Set<ProviderId>(["faux", ...providerIds])) registerProvider(models, id, options);
}

/** Register one provider on a model collection. Unknown ids are refused, never defaulted. */
export function registerProvider(models: MutableModels, providerId: ProviderId, options: { ollamaBaseUrl?: string } = {}): void {
  switch (providerId) {
    case "faux":
      installFaux(models);
      return;
    case "openrouter": {
      const provider = openrouterProvider();
      const catalog = provider.getModels();
      for (const model of curatedModels)
        if (!catalog.some((m) => m.id === model.id)) throw Error(`OpenRouter catalog missing ${model.id}`);
      models.setProvider({
        ...provider,
        getModels: () => catalog.filter((m) => curatedModels.some((c) => c.id === m.id)),
      });
      return;
    }
    case "radius":
      models.setProvider(radiusProvider());
      return;
    case "ollama":
      models.setProvider(ollamaProvider(options.ollamaBaseUrl ?? ollamaBaseUrl()));
      return;
  }
}

type LiveModel = {
  id: string;
  name?: string;
  contextWindow: number;
  reasoning: boolean;
  cost?: { input: number; output: number };
};

/** Device model rows. Curated metadata names a model when it has any; otherwise the model names itself. */
export function modelInfos(providerId: ProviderId, available: readonly LiveModel[]): ModelInfo[] {
  return available.map((model) => {
    const curated = curatedModels.find((c) => c.id === model.id);
    return {
      id: model.id,
      provider: providerId,
      name: curated?.name ?? model.name ?? model.id,
      tier: curated?.tier ?? "T",
      icon: curated?.icon ?? "lab.png",
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
    };
  });
}

/** The model a new session gets when the caller names none. */
export function defaultModelFor(providerId: ProviderId, available: readonly { id: string }[]): string {
  if (providerId === "faux") return fauxModels[0].id;
  const preferred = providerId === "openrouter" ? defaultModelId : providerId === "radius" ? "balanced" : available[0]?.id;
  // If the external provider has no auth/model yet, default to the free Faux model, never a
  // guessed or paid model. The user must explicitly choose a remote model from the catalog.
  return preferred && available.some((model) => model.id === preferred) ? preferred : fauxModels[0].id;
}
