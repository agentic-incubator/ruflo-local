// Tests for the OpenAI-compatible gateway client. fetch is injected, so no network:
// we assert the curl-equivalent semantics (throw-on-error vs degrade-to-empty).

import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayClient } from "../gateway-client.mjs";

/** Build a fake fetch that returns a canned Response-like object (or throws). */
function fakeFetch(handler) {
  return async (url, opts) => handler(url, opts);
}
const okJson = (obj) => ({ ok: true, status: 200, statusText: "OK", json: async () => obj, text: async () => JSON.stringify(obj) });
const okText = (txt) => ({ ok: true, status: 200, statusText: "OK", text: async () => txt });
const bad = (status = 500) => ({ ok: false, status, statusText: "ERR", json: async () => ({}), text: async () => "" });

test("chat resolves the parsed body on 2xx", async () => {
  const client = new GatewayClient({ fetchImpl: fakeFetch(() => okJson({ choices: [{ message: { content: "hi" } }] })) });
  const data = await client.chat({ model: "m" });
  assert.equal(data.choices[0].message.content, "hi");
});

test("chat throws on non-2xx (the curl -f contract)", async () => {
  const client = new GatewayClient({ fetchImpl: fakeFetch(() => bad(429)) });
  await assert.rejects(() => client.chat({ model: "m" }), /429/);
});

test("chatContent returns content on success", async () => {
  const client = new GatewayClient({ fetchImpl: fakeFetch(() => okJson({ choices: [{ message: { content: "OK" } }] })) });
  assert.equal(await client.chatContent({ model: "m" }), "OK");
});

test("chatContent degrades to empty string on error", async () => {
  const thrower = new GatewayClient({ fetchImpl: fakeFetch(() => { throw new Error("network down"); }) });
  assert.equal(await thrower.chatContent({ model: "m" }), "");
  const errStatus = new GatewayClient({ fetchImpl: fakeFetch(() => bad(500)) });
  assert.equal(await errStatus.chatContent({ model: "m" }), "");
});

test("chatContent returns empty when choices/content is missing", async () => {
  const client = new GatewayClient({ fetchImpl: fakeFetch(() => okJson({})) });
  assert.equal(await client.chatContent({ model: "m" }), "");
});

test("metrics returns text on success and throws on failure", async () => {
  const ok = new GatewayClient({ fetchImpl: fakeFetch(() => okText("litellm_total_tokens 5")) });
  assert.match(await ok.metrics(), /litellm_total_tokens/);
  const err = new GatewayClient({ fetchImpl: fakeFetch(() => bad(503)) });
  await assert.rejects(() => err.metrics(), /503/);
});

test("health is true if liveliness answers, false if everything fails", async () => {
  const live = new GatewayClient({ fetchImpl: fakeFetch((u) => (u.endsWith("/health/liveliness") ? okText("alive") : bad())) });
  assert.equal(await live.health(), true);
  const dead = new GatewayClient({ fetchImpl: fakeFetch(() => { throw new Error("down"); }) });
  assert.equal(await dead.health(), false);
});

test("chatTimed returns content plus non-negative wall-clock seconds", async () => {
  const client = new GatewayClient({ fetchImpl: fakeFetch(() => okJson({ choices: [{ message: { content: "OK" } }] })) });
  const { content, seconds } = await client.chatTimed({ model: "m" });
  assert.equal(content, "OK");
  assert.ok(seconds >= 0);
});
