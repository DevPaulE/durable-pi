// Provider selection: Faux stays the default, every other provider is explicit,
// and an unknown DPI_PROVIDER fails closed instead of silently becoming OpenRouter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { tempStore } from "./helpers.js";
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
    if (req.url?.endsWith("/models")) {
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

test("Ollama Cloud: an empty catalog is an error, not a silent success", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    await assert.rejects(() => fetchOllamaModels(baseUrl, "test-key"), /returned no models/);
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

test("adding a remote provider does not re-point an existing Faux session", async () => {
  // The device default becomes openrouter, but faux stays registered beside it.
  const t = await tempStore();
  const store = await Store.open({ ...t.options, provider: "openrouter", providers: ["openrouter", "faux"] });
  try {
    // Faux is still a valid choice, so a stored Faux session keeps working.
    assert.deepEqual(store.validateModel({ provider: "faux", modelId: "echo" }), { provider: "faux", modelId: "echo" });
    // The stored choice is honoured as-is instead of being re-pointed at a paid model.
    assert.deepEqual(store.routedModel({ provider: "faux", modelId: "echo" }), { provider: "faux", modelId: "echo" });
    // Faux rows are still offered alongside the remote provider's.
    assert.ok(store.modelList.some((m) => m.provider === "faux"), "faux models remain listed");
    // A provider that was not registered is still refused.
    assert.throws(() => store.validateModel({ provider: "ollama", modelId: "whatever" }), /Unknown model/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a Faux session reopened after the device adds a provider keeps its own model", async () => {
  const t = await tempStore();
  let store = await t.open();
  const session = await store.create({ name: "Practice", cwd: t.work, model: { provider: "faux", modelId: "echo" } });
  await store.close();

  // Same device, same data dir — now defaulting to openrouter with faux registered beside it.
  store = await Store.open({ ...t.options, provider: "openrouter", providers: ["openrouter", "faux"] });
  try {
    const row = store.list().find((s) => s.id === session.id)!;
    assert.equal(row.provider, "faux", "stored provider is untouched by the new default");
    assert.equal(row.model, "echo");
    // Recovery routes the stored choice to itself, not to the device's new default.
    assert.deepEqual(store.routedModel({ provider: row.provider, modelId: row.model }), { provider: "faux", modelId: "echo" });
    // With no OpenRouter credential the remote catalog is empty, so nothing paid is offered.
    assert.deepEqual(store.modelList.filter((m) => m.provider === "openrouter"), []);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
