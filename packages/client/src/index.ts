export { RemoteServiceAccess } from "./remoteServiceAccess.js";
export { connectViaProtocol, connectViaWebSocket } from "./websocket.js";
export type { WebSocketConnectionCloseEvent } from "./websocket.js";
export { ReconnectingWebChannel } from "./reconnectingWebChannel.js";
export type { ReconnectingWebChannelOptions, WebChannelState } from "./reconnectingWebChannel.js";
export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  buildHeartbeatFrame,
  classifyConnectProbe,
  reconnectDelayMs,
  resetBackoff,
} from "./reconnectPolicy.js";
export type { ConnectProbeOutcome } from "./reconnectPolicy.js";
export { connectViaMessagePort, createMessagePortServiceConnection } from "./messageport.js";
export type { MessagePortServiceConnection } from "./messageport.js";
