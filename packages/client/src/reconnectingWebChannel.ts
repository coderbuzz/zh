// Reconnecting browser WebSocket channel for web mode.
//
// The plain connectViaWebSocket() gives the app a service stack but no story
// for a dead socket: proxies into a half-open WebSocket hang forever, which
// is exactly the "send button spins forever until the user refreshes" bug.
// This channel owns the socket lifecycle instead:
//
// - detects dead sockets even when the browser has not fired close yet
//   (app-level KeepAlive probe echoed by the zh server, since browsers cannot
//   see protocol pings);
// - fails fast on disconnect: the ChannelClient is disposed with a clear
//   error, so pending RPC promises reject instead of hanging (the composer
//   surfaces them through its normal send-failure banner);
// - reconnects with exponential backoff + jitter, and can be poked to retry
//   immediately when the tab becomes visible, the network returns, or the
//   page is restored from bfcache;
// - classifies a failed upgrade by probing the origin over HTTP: a redirect
//   or 401/403 means the auth wall (e.g. an expired Cloudflare Access
//   session) is answering the upgrade with something other than 101 —
//   retrying cannot help, so retrying stops and the caller reloads the page
//   so the browser can log in again.

import { ChannelClient, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  buildHeartbeatFrame,
  classifyConnectProbe,
  reconnectDelayMs,
  resetBackoff,
} from "./reconnectPolicy.js";

export type WebChannelState = "connecting" | "connected" | "reconnecting";

export interface ReconnectingWebChannelOptions {
  wsUrl: string;
  /** Same-origin URL probed over HTTP to classify a failed upgrade. */
  probeUrl?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  onStateChange?: (state: WebChannelState) => void;
  /** Fires on the first connect and after every successful reconnect. */
  onConnected?: (services: IServiceAccessor) => void;
  /**
   * The upgrade is being rejected by the auth layer (redirect/401/403).
   * Retrying is pointless; the caller should reload the page so the browser
   * can re-authenticate.
   */
  onAuthExpired?: () => void;
}

interface ActiveConnection {
  ws: WebSocket;
  client: ChannelClient;
  protocol: SocketProtocol;
}

export class ReconnectingWebChannel {
  private readonly options: ReconnectingWebChannelOptions;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  private state: WebChannelState = "connecting";
  private disposed = false;
  private active: ActiveConnection | null = null;
  private opening = false;
  private attempt = 0;
  private connectedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of the last unanswered heartbeat probe; null once traffic arrived. */
  private awaitingHeartbeatSince: number | null = null;
  private lastPokeAt = 0;

  constructor(options: ReconnectingWebChannelOptions) {
    this.options = options;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  getState(): WebChannelState {
    return this.state;
  }

  start(): void {
    if (this.disposed || this.active || this.opening || this.reconnectTimer) {
      return;
    }
    this.setState("connecting");
    this.openSocket();
  }

  /**
   * Retry immediately instead of waiting out the backoff. Safe to call from
   * visibilitychange/online/pageshow handlers as often as they fire; while
   * connected it runs an immediate liveness probe instead.
   */
  poke(): void {
    if (this.disposed) {
      return;
    }
    const now = Date.now();
    if (this.active) {
      if (this.isHeartbeatOverdue(now)) {
        this.abandonActive(new Error("zh: websocket heartbeat timeout"));
        return;
      }
      if (now - this.lastPokeAt >= 1_000) {
        this.lastPokeAt = now;
        this.sendHeartbeat();
      }
      return;
    }
    if (this.opening || now - this.lastPokeAt < 500) {
      return;
    }
    this.lastPokeAt = now;
    this.cancelReconnectTimer();
    this.setState("reconnecting");
    this.openSocket();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelReconnectTimer();
    this.stopHeartbeat();
    this.teardownActive(new Error("zh: web channel disposed"));
  }

  private setState(state: WebChannelState): void {
    if (this.state !== state) {
      this.state = state;
      this.options.onStateChange?.(state);
    }
  }

  private openSocket(): void {
    if (this.disposed || this.active || this.opening) {
      return;
    }
    this.opening = true;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.wsUrl);
    } catch {
      this.opening = false;
      this.handleConnectFailure();
      return;
    }
    ws.binaryType = "arraybuffer";

    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.opening = false;
      this.onSocketOpen(ws);
    });
    // A failed upgrade fires error then close; only the close handler decides
    // what happens next so both paths share one code path. Stale close
    // events from an already-abandoned socket must not tear down its
    // successor, hence the identity check.
    ws.addEventListener("close", () => {
      if (opened) {
        if (this.active?.ws === ws) {
          this.abandonActive(
            new Error("zh: websocket connection lost while a request was in flight"),
          );
        }
      } else {
        this.opening = false;
        this.handleConnectFailure();
      }
    });
  }

  private onSocketOpen(ws: WebSocket): void {
    if (this.disposed) {
      ws.close();
      return;
    }
    const socket = wrapBrowserWebSocket(ws, () => {
      // Any inbound frame proves the path is alive.
      this.awaitingHeartbeatSince = null;
    });
    const protocol = new SocketProtocol(socket);
    const client = new ChannelClient(protocol);
    this.active = { ws, client, protocol };
    this.attempt = 0;
    this.connectedAt = Date.now();
    this.awaitingHeartbeatSince = null;
    this.setState("connected");
    this.startHeartbeat();
    this.options.onConnected?.(new RemoteServiceAccess(client));
  }

  private handleConnectFailure(): void {
    if (this.disposed) {
      return;
    }
    this.setState("reconnecting");
    void this.probeThenSchedule();
  }

  private async probeThenSchedule(): Promise<void> {
    const outcome = await this.probeOrigin();
    if (this.disposed || this.active || this.opening) {
      return;
    }
    if (outcome === "auth") {
      this.cancelReconnectTimer();
      this.options.onAuthExpired?.();
      return;
    }
    this.scheduleReconnect();
  }

  private async probeOrigin(): Promise<"auth" | "reachable" | "unreachable" | "server-error"> {
    // wss://host/ws → https://host/api/server-info
    const probeUrl =
      this.options.probeUrl ??
      `${this.options.wsUrl.replace(/^ws/i, "http")}`.replace(/\/ws(\/.*)?$/, "/api/server-info");
    try {
      // redirect:"manual" stops at the auth redirect instead of following it
      // (following a cross-origin Cloudflare Access redirect would just throw
      // an opaque network error indistinguishable from being offline).
      const response = await fetch(probeUrl, {
        cache: "no-store",
        redirect: "manual",
      });
      return classifyConnectProbe({
        ok: response.ok,
        status: response.status,
        type: response.type,
      });
    } catch {
      return "unreachable";
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.active || this.opening || this.reconnectTimer) {
      return;
    }
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed && !this.active && !this.opening) {
        this.openSocket();
      }
    }, delay);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.active) {
        this.stopHeartbeat();
        return;
      }
      if (this.isHeartbeatOverdue(Date.now())) {
        this.abandonActive(new Error("zh: websocket heartbeat timeout"));
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingHeartbeatSince = null;
  }

  private isHeartbeatOverdue(now: number): boolean {
    return (
      this.awaitingHeartbeatSince !== null &&
      now - this.awaitingHeartbeatSince > this.heartbeatTimeoutMs
    );
  }

  private sendHeartbeat(): void {
    if (!this.active || this.active.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.active.ws.send(buildHeartbeatFrame());
    this.awaitingHeartbeatSince = Date.now();
  }

  /** Tear the current connection down and start the reconnect cycle. */
  private abandonActive(reason: Error): void {
    if (!this.active || this.disposed) {
      return;
    }
    const held = Date.now() - this.connectedAt;
    this.stopHeartbeat();
    this.teardownActive(reason);
    if (resetBackoff(held)) {
      this.attempt = 0;
    }
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private teardownActive(reason: Error): void {
    const active = this.active;
    this.active = null;
    if (!active) {
      return;
    }
    // Fails every in-flight promise call so the UI reports an error instead
    // of spinning forever; later calls on the disposed client reject too.
    active.client.dispose(reason);
    active.protocol.dispose();
    try {
      active.ws.close();
    } catch {
      // already closing/closed
    }
  }
}

/**
 * ISocket adapter over a live browser WebSocket. Close semantics are owned by
 * ReconnectingWebChannel (watching the raw socket); SocketProtocol only
 * consumes data, so onClose/onEnd stay unsubscribable stubs.
 */
function wrapBrowserWebSocket(ws: WebSocket, onInbound: () => void): ISocket {
  ws.binaryType = "arraybuffer";
  const onData = new Emitter<VSBuffer>();

  const onMessage = (event: Event) => {
    onInbound();
    onData.fire(VSBuffer.wrap(new Uint8Array((event as MessageEvent).data as ArrayBuffer)));
  };
  ws.addEventListener("message", onMessage);

  return {
    onData: onData.event,
    onClose: () => () => {},
    onEnd: () => () => {},
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.removeEventListener("message", onMessage);
      ws.close();
    },
  };
}
