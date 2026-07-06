// Tests for bufferStream — the shared "settle-once" guard behind gateway-server.mjs's
// collectBody/collectResponseBody. Uses a plain EventEmitter as the fake stream; the
// helper only ever calls stream.on(...), never anything req/res-specific.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { bufferStream } from "../collect-body.mjs";

const OPTS = { maxBytes: 10, tooLargeCode: "TOO_LARGE", tooLargeMsg: "too large", abortCode: "ABORTED", abortMsg: "aborted" };

test("resolves with the concatenated buffer on 'end'", async () => {
  const stream = new EventEmitter();
  const promise = bufferStream(stream, OPTS);
  stream.emit("data", Buffer.from("ab"));
  stream.emit("data", Buffer.from("cd"));
  stream.emit("end");

  assert.equal((await promise).toString(), "abcd");
});

test("rejects with tooLargeCode/tooLargeMsg once total bytes exceed maxBytes", async () => {
  const stream = new EventEmitter();
  const promise = bufferStream(stream, OPTS);
  stream.emit("data", Buffer.from("x".repeat(11)));

  await assert.rejects(promise, (err) => {
    assert.equal(err.code, "TOO_LARGE");
    assert.equal(err.message, "too large");
    return true;
  });
});

test("rejects with abortCode/abortMsg on 'close' before 'end' ever fires", async () => {
  const stream = new EventEmitter();
  const promise = bufferStream(stream, OPTS);
  stream.emit("data", Buffer.from("ab"));
  stream.emit("close");

  await assert.rejects(promise, (err) => {
    assert.equal(err.code, "ABORTED");
    assert.equal(err.message, "aborted");
    return true;
  });
});

test("rejects with the raw error on 'error'", async () => {
  const stream = new EventEmitter();
  const promise = bufferStream(stream, OPTS);
  const boom = new Error("boom");
  stream.emit("error", boom);

  await assert.rejects(promise, (err) => err === boom);
});

test("settles exactly once — a 'close' firing after 'end' is a no-op, not a second rejection", async () => {
  const stream = new EventEmitter();
  const promise = bufferStream(stream, OPTS);
  stream.emit("data", Buffer.from("ok"));
  stream.emit("end");
  stream.emit("close"); // must not flip the already-resolved promise to rejected

  assert.equal((await promise).toString(), "ok");
});

test("a chunk landing exactly at maxBytes is accepted, not rejected (off-by-one boundary)", async () => {
  const stream = new EventEmitter();
  const promise = bufferStream(stream, OPTS);
  stream.emit("data", Buffer.from("x".repeat(10)));
  stream.emit("end");

  assert.equal((await promise).length, 10);
});
