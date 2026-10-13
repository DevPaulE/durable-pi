// Provider selection: Faux stays the default, every other provider is explicit,
// and an unknown DPI_PROVIDER fails closed instead of silently becoming OpenRouter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  fetchOllamaModels,
  isProviderId,
  modelInfos,
  PROVIDER_IDS,
} from "../src/providers.js";

const baseEnv = { DPI_TOKEN: "x".repeat(40), DPI_ENV_FILE: "/nonexistent/absent.env" };

test("provider ids: known values accepted, anything else rejected", () => {
  assert.deepEqual([...PROVIDER_IDS], ["faux", "openrouter", "radius", "ollama"]);
  for (const id of PROVIDER_IDS) assert.equal(isProviderId(id), true, id);
  for (const bad of ["", "nope", "Faux", "openai", "openrouter ", "fauxx"]) assert.equal(isProviderId(bad), false, bad);
});

test("config: DPI_PROVIDER is validated instead of silently falling back", () => {
  assert.equal(loadConfig([], { ...baseEnv, DPI_PROVIDER: "faux" }).provider, "faux");
  assert.equal(loadConfig([], { ...baseEnv, DPI_PROVIDER: "openrouter" }).provider, "openrouter");
  assert.equal(loadConfig([], { ...baseEnv, DPI_PROVIDER: "radius" }).provider, "radius");
  assert.equal(loadConfig([], { ...baseEnv, DPI_PROVIDER: "ollama" }).provider, "ollama");
  assert.throws(() => loadConfig([], { ...baseEnv, DPI_PROVIDER: "nope" }), /DPI_PROVIDER/);
  assert.throws(() => loadConfig([], { ...baseEnv, DPI_PROVIDER: "openai" }), /DPI_PROVIDER/);
  // Unset keeps the documented OpenRouter default.
  assert.equal(loadConfig([], baseEnv).provider, "openrouter");
});

test("Ollama Cloud: the catalog comes from the endpoint, with the key as a bearer token", async () => {
  let seenAuth: string | undefined;
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    if (req.url === "/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "gemma4:31b", object: "model" }, { id: "qwen3:cloud", object: "model" }] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    const models = await fetchOllamaModels(baseUrl, "test-key");
    assert.equal(seenAuth, "Bearer test-key");
    assert.deepEqual(models.map((m) => m.id), ["gemma4:31b", "qwen3:cloud"]);
    for (const m of models) {
      assert.equal(m.provider, "ollama");
      assert.equal(m.api, "openai-completions");
      assert.equal(m.baseUrl, baseUrl);
    }
  } finally {
    server.close();
  }
});

test("Ollama Cloud: a non-200 answer fails loudly instead of returning an empty catalog", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    await assert.rejects(() => fetchOllamaModels(baseUrl, "bad-key"), /401/);
  } finally {
    server.close();
  }
});

test("model info: rows carry the provider that produced them", () => {
  const rows = modelInfos("ollama", [
    { id: "gemma4:31b", name: "gemma4:31b", contextWindow: 128000, reasoning: false, cost: { input: 0, output: 0 } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "ollama");
  assert.equal(rows[0].id, "gemma4:31b");
  assert.equal(DEFAULT_OLLAMA_BASE_URL, "https://ollama.com/v1");
});
