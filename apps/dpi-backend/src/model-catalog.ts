// Source: https://agenticengineer.com/model-stack, retrieved 2026-10-05.
// Active S+, S, A and B models, matched to https://openrouter.ai/api/v1/models.
// Gemini 4 Argon is rolling out and has no OpenRouter listing at this snapshot.
//
// 2026-11-18: moonshotai/kimi-k3.1-pro replaces moonshotai/kimi-k3. K3.1 Pro is in the live
// OpenRouter catalog and in pi's model store; nothing was running on K3 when it was dropped
// (checked every session and agent on this device). Its tier is carried from the K3 row and is
// a vendor label, not a measurement — see ~/dpi-work/team/bench/MODEL-LIST-REVIEW-2026-11-18.md.
export const curatedModels = [
  {
    id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-fable-5.1",
    name: "Claude Fable 5.1",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-astra",
    name: "GPT-6 Astra",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-opus-5",
    name: "Opus 5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-fable-5",
    name: "Fable 5",
    tier: "S",
    icon: "anthropic.png",
  },
  {
    id: "meta/muse-spark-1.3",
    name: "Muse Spark 1.3",
    tier: "S",
    icon: "meta.png",
  },
  {
    id: "openai/gpt-6-sol",
    name: "GPT-6 Sol",
    tier: "S",
    icon: "openai.png",
  },
  {
    id: "x-ai/grok-4.7",
    name: "Grok 4.7",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "xiaomi/mimo-v2.6-pro",
    name: "MiMo-V2.6-Pro",
    tier: "S",
    icon: "xiaomi.png",
  },
  {
    id: "x-ai/grok-4.6",
    name: "Grok 4.6",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "z-ai/glm-5.3",
    name: "GLM-5.3",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "moonshotai/kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    tier: "A",
    icon: "kimi.png",
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT 5.6 Terra",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "qwen/qwen3.8-2.4t-a95b",
    name: "Qwen3.8-2.4T-A95B",
    tier: "A",
    icon: "qwen.png",
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "google/gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Sonnet 5",
    tier: "A",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    tier: "A",
    icon: "xiaomi.png",
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "deepseek/deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro 0813",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM-5.2",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3-Flash",
    tier: "B",
    icon: "zai.png",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    tier: "B",
    icon: "gemini.png",
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax-M3",
    tier: "B",
    icon: "minimax.png",
  },
  {
    id: "google/gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    tier: "B",
    icon: "gemini.png",
  },
] as const;
// Cheapest curated model with usable capability, kept as the default so new sessions do not
// silently start on a top-tier paid model.
export const defaultModelId = "deepseek/deepseek-v4.1-flash";
/** The plan-covered default on Ollama Cloud (same model the LifeOS pi session runs). */
// The OLLAMA CLOUD default. Against a loopback OLLAMA_BASE_URL this id is not in the catalog,
// which the fail-closed in defaultModelFor() then resolves to Faux — so a device whose base URL
// is its own `ollama serve` must declare its default in OLLAMA_DEFAULT_MODEL (a per-device
// declaration, alongside OLLAMA_BASE_URL). Observed 2026-11-14: the M1 Max ran DPI_PROVIDER=ollama
// with 11 local models and a default of "echo".
export const ollamaDefaultModelId = "glm-5.3-flash";
