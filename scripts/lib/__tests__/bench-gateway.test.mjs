// =============================================================================
// bench-gateway.test.mjs — node:test coverage for the bench-gateway.mjs port.
//
// AAA (Arrange-Act-Assert). Network is never touched: benchGateway() is exercised
// with an injected stub client ({health, chatTimed}), mirroring gateway-client's own
// test doubles rather than mocking fetch.
// =============================================================================

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { percentiles, benchGateway } from "../bench-gateway.mjs";

describe("percentiles", () => {
  test("should_returnExactNearestRankValues_when_givenTenAscendingSamples", () => {
    // Arrange
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

    // Act
    const result = percentiles(samples);

    // Assert: idx = trunc((p/100)*10), clamped to [1,10]; a[idx] is 1-indexed.
    // p50 -> idx=5 -> a[5] = 0.5 ; p95 -> idx=9 -> a[9] = 0.9
    assert.equal(result.p50, 0.5);
    assert.equal(result.p95, 0.9);
    assert.equal(result.mean, 0.55);
  });
});

describe("benchGateway", () => {
  test("should_returnSkippedUnreachable_when_healthCheckFails", async () => {
    // Arrange
    const stub = { health: async () => false };

    // Act
    const result = await benchGateway({ client: stub, env: { GW: "http://x" } });

    // Assert
    assert.deepEqual(result, {
      gateway: undefined,
      samples: 0,
      status: "skipped",
      note: "gateway unreachable — start one variant first (COMPOSE_PROFILES=<gw> docker compose up -d)",
    });
  });

  test("should_returnOkWithSamples_when_allCompletionsSucceed", async () => {
    // Arrange
    const stub = {
      gateway: "http://x",
      health: async () => true,
      chatTimed: async () => ({ content: "OK", seconds: 0.2 }),
    };
    const env = { N: "5", GW: "http://x" };

    // Act
    const result = await benchGateway({ client: stub, env });

    // Assert
    assert.equal(result.status, "ok");
    assert.equal(result.samples, 5);
    assert.equal(result.gateway, "http://x");
    assert.equal(result.model, "tier-fast");
    assert.deepEqual(result.seconds, { p50: 0.2, p95: 0.2, mean: 0.2 });
    assert.match(result.note, /compare the SAME model/);
  });

  test("should_returnSkippedNoCompletions_when_everyCallReturnsEmptyContent", async () => {
    // Arrange
    const stub = {
      gateway: "http://x",
      health: async () => true,
      chatTimed: async () => ({ content: "", seconds: 0.2 }),
    };
    const env = { N: "5", GW: "http://x" };

    // Act
    const result = await benchGateway({ client: stub, env });

    // Assert
    assert.deepEqual(result, {
      gateway: "http://x",
      samples: 0,
      status: "skipped",
      note: "gateway reachable but no completions succeeded (no model loaded / no key?)",
    });
  });
});
