import assert from "node:assert/strict";
import test from "node:test";
import {
  RECONNECT_MAX_DELAY_MS,
  buildHeartbeatFrame,
  classifyConnectProbe,
  reconnectDelayMs,
  resetBackoff,
} from "../src/reconnectPolicy.js";

test("reconnect backoff grows exponentially and is capped", () => {
  const deterministic = () => 0.5; // zero jitter around the center
  assert.equal(reconnectDelayMs(0, deterministic), 500);
  assert.equal(reconnectDelayMs(1, deterministic), 1000);
  assert.equal(reconnectDelayMs(2, deterministic), 2000);
  assert.equal(reconnectDelayMs(3, deterministic), 4000);
  assert.equal(reconnectDelayMs(4, deterministic), 8000);
  assert.equal(reconnectDelayMs(5, deterministic), RECONNECT_MAX_DELAY_MS);
  assert.equal(reconnectDelayMs(20, deterministic), RECONNECT_MAX_DELAY_MS);
});

test("reconnect backoff jitter stays within ±25% of the base delay", () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const exponential = Math.min(500 * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
    for (let sample = 0; sample < 200; sample += 1) {
      const delay = reconnectDelayMs(attempt);
      assert.ok(
        delay >= exponential * 0.75 && delay <= exponential * 1.25,
        `attempt ${attempt} produced ${delay}, expected within ±25% of ${exponential}`,
      );
    }
  }
});

test("backoff resets only after a stable connection", () => {
  assert.equal(resetBackoff(9_999), false);
  assert.equal(resetBackoff(10_000), true);
});

test("connect probe classification", () => {
  // Cloudflare Access answering the upgrade with a login redirect.
  assert.equal(classifyConnectProbe({ ok: false, status: 0, type: "opaqueredirect" }), "auth");
  assert.equal(classifyConnectProbe({ ok: false, status: 401, type: "response" }), "auth");
  assert.equal(classifyConnectProbe({ ok: false, status: 403, type: "response" }), "auth");
  // Engines that expose the 3xx instead of an opaque redirect (and the zh
  // server never legitimately redirects the probe endpoint).
  assert.equal(classifyConnectProbe({ ok: false, status: 302, type: "default" }), "auth");
  assert.equal(classifyConnectProbe({ ok: false, status: 307, type: "default" }), "auth");
  // Server healthy / tunnel up.
  assert.equal(classifyConnectProbe({ ok: true, status: 200, type: "response" }), "reachable");
  assert.equal(classifyConnectProbe({ ok: false, status: 502, type: "response" }), "server-error");
  // Anything else: retry, reload cannot help.
  assert.equal(classifyConnectProbe({ ok: false, status: 404, type: "response" }), "unreachable");
});

test("heartbeat frame is a 13-byte zero-payload KeepAlive frame", () => {
  const frame = buildHeartbeatFrame();
  assert.equal(frame.byteLength, 13);
  assert.equal(frame[0], 0x09);
  assert.ok(frame.every((byte, index) => index === 0 || byte === 0));
});
