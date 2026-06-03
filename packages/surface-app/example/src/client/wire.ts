/**
 * Surface client bundle + a live connection-status signal.
 *
 * `app` is the control-plane surface client (carries the global `buildInfo`
 * cell). `connectionStatus` is derived from the PartySocket open/close events —
 * surface-app's model takes it as an input, so the rail can show live/reconnecting.
 */

import { websocketLink } from "@kolu/surface/links/websocket";
import { surfaceClient } from "@kolu/surface/solid";
import type { ConnectionStatus } from "@kolu/surface-app/solid";
import { WebSocket as PartySocket } from "partysocket";
import { createSignal } from "solid-js";
import { surface } from "../common/surface";

const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc/ws`;
export const ws = new PartySocket(wsUrl);

const [status, setStatus] = createSignal<ConnectionStatus>("reconnecting");
ws.addEventListener("open", () => setStatus("live"));
ws.addEventListener("close", () => setStatus("reconnecting"));
export const connectionStatus = status;

export const app = surfaceClient(
  surface,
  websocketLink<typeof surface.contract>(ws as unknown as WebSocket),
);
