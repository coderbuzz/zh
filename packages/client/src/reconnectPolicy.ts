// Pure reconnect policy for the web WebSocket channel: backoff schedule and
// auth-failure classification. Kept dependency-free so it can be unit-tested
// without a DOM or a network (packages/client/test/reconnectPolicy.test.ts).

export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 10_000;
/** Jitter fraction applied to each computed delay (±25%). */
export const RECONNECT_JITTER = 0.25;
/** A connection that stayed up at least this long resets the backoff counter. */
export const STABLE_CONNECTION_MS = 10_000;

/**
 * Exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, then capped at 10s.
 * Jitter spreads reconnect storms (server restart, network flap) so many
 * clients do not retry in lockstep.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
    RECONNECT_MAX_DELAY_MS,
  );
  const jitterRange = exponential * RECONNECT_JITTER;
  return Math.round(exponential - jitterRange + random() * jitterRange * 2);
}

export function resetBackoff(connectionHeldForMs: number): boolean {
  return connectionHeldForMs >= STABLE_CONNECTION_MS;
}

export type ConnectProbeOutcome = "auth" | "reachable" | "unreachable" | "server-error";

/**
 * Classify a failed WebSocket upgrade by probing the HTTP endpoint over the
 * same origin. Browser WebSocket API cannot see the HTTP status of the
 * upgrade (Cloudflare Access answers a stale session with 302/403, not 101),
 * so the probe decides whether retrying can ever succeed:
 * - redirect (opaque in browsers; 3xx status on engines that expose it) or
 *   401/403 → auth wall → stop retrying and reload the page so the browser
 *   performs the login dance;
 * - 200 → server is up, the upgrade failed for a transient reason → retry;
 * - 5xx (tunnel up, origin down) → retry;
 * - fetch threw (offline / tunnel down) → retry, plus poke on `online`.
 *
 * A 3xx on the probe is treated as auth unconditionally: the zh server only
 * ever answers the probe endpoint with JSON (200/401/5xx), never a redirect.
 */
export function classifyConnectProbe(response: {
  ok: boolean;
  status: number;
  type: string;
}): ConnectProbeOutcome {
  if (response.type === "opaqueredirect") {
    return "auth";
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status >= 300 && response.status < 400)
  ) {
    return "auth";
  }
  if (response.ok) {
    return "reachable";
  }
  if (response.status >= 500) {
    return "server-error";
  }
  return "unreachable";
}

export const HEARTBEAT_FRAME_BYTES = 13;
export const KEEPALIVE_FRAME_TYPE = 0x09;

/**
 * Zero-payload KeepAlive frame (13-byte rpc header: type, id, ack, length).
 * The zh web server echoes it verbatim; SocketProtocol on both ends ignores
 * the frame type, so the probe never reaches the RPC layer.
 */
export function buildHeartbeatFrame(): Uint8Array {
  const frame = new Uint8Array(HEARTBEAT_FRAME_BYTES);
  frame[0] = KEEPALIVE_FRAME_TYPE;
  return frame;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** No echo (or any inbound frame) within this window → declare the socket dead. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 6_000;
