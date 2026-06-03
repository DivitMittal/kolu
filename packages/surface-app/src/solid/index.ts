/**
 * @kolu/surface-app/solid — the headless app-shell model + SW retirement.
 *
 * The library provides the MODEL (`useSurfaceApp()` → relationship-to-server +
 * reload + desktop affordances); the app renders the chrome (badge, rail, prompt)
 * in its own CSS. Build-skew is one `status` among connection states — the
 * unifying insight made concrete. Fed YOUR control-plane surface client + YOUR
 * baked commit; the library never imports your rpc or your build define.
 *
 * Written without JSX syntax (uses `createComponent`) so it's safely consumable
 * from `node_modules` without the consumer's Solid JSX transform reaching in.
 */

import {
  type Accessor,
  createComponent,
  createContext,
  createSignal,
  type JSX,
  useContext,
} from "solid-js";
import {
  buildInfo as defaultBuildInfo,
  type BuildInfoDef,
} from "../surface.ts";

// The non-component lifecycle calls live in the framework-free `/lifecycle`
// subpath; re-exported here so `<SurfaceAppProvider>` consumers reach them from
// one import. Apps with no component in scope (root setup) import `/lifecycle`.
export { reloadForUpdate, retireServiceWorker } from "../lifecycle.ts";
import { reloadForUpdate } from "../lifecycle.ts";

/** The live relationship to the server this client is bound to. */
export type ConnectionStatus = "live" | "reconnecting" | "restarted" | "down";

/** The full lifecycle of that relationship — connecting, connected, a transient
 *  drop (`disconnected` → `reconnected`), or a server restart (a new `processId`
 *  after a drop). This is kolu's `rpc.ts` lifecycle, encapsulated so every
 *  surface app derives it instead of re-deriving it. */
export type ServerLifecycleEvent =
  | { kind: "connecting" }
  | { kind: "connected"; processId: string }
  | { kind: "disconnected" }
  | { kind: "reconnected"; processId: string }
  | { kind: "restarted"; processId: string };

/** What an identity probe reports: the server process id — a value that changes
 *  when the server restarts (so a reconnect to a *different* process is a restart,
 *  not a transient drop). Kept distinct from build identity (`commit`). Matches
 *  `ServerProbeSchema` from `@kolu/surface-app/surface`; an app may send a
 *  superset (the provider is generic over the probe response — see `P`). */
export interface ServerProbe {
  processId: string;
}

/** The transport surface-app observes — `WebSocket` / `PartySocket` both fit. */
export interface WsLike {
  addEventListener(type: "open" | "close", listener: () => void): void;
}

function statusOf(kind: ServerLifecycleEvent["kind"]): ConnectionStatus {
  switch (kind) {
    case "connecting":
      return "reconnecting";
    case "disconnected":
      return "down";
    case "restarted":
      return "restarted";
    default:
      return "live"; // connected | reconnected
  }
}

/** Derive the server lifecycle from a transport + an identity probe — the generic
 *  form of kolu's `rpc.ts`. On each `open` the probe reads the server's
 *  `processId`: the first connect is `connected`; a later one is `reconnected`
 *  (same id) or `restarted` (changed). A `close` after the first connect is
 *  `disconnected`. Run inside a reactive owner (e.g. `<SurfaceAppProvider>`). */
export function createServerLifecycle<
  P extends ServerProbe = ServerProbe,
>(opts: {
  ws: WsLike;
  probe: () => Promise<P>;
}): {
  lifecycle: Accessor<ServerLifecycleEvent>;
  status: Accessor<ConnectionStatus>;
  serverProcessId: Accessor<string | undefined>;
} {
  const [lifecycle, setLifecycle] = createSignal<ServerLifecycleEvent>({
    kind: "connecting",
  });
  let connectCount = 0;
  let knownProcessId: string | null = null;
  opts.ws.addEventListener("open", () => {
    connectCount++;
    const isFirst = connectCount === 1;
    opts
      .probe()
      .then(({ processId }) => {
        if (isFirst) {
          knownProcessId = processId;
          setLifecycle({ kind: "connected", processId });
          return;
        }
        const restarted =
          knownProcessId !== null && processId !== knownProcessId;
        knownProcessId = processId;
        setLifecycle({
          kind: restarted ? "restarted" : "reconnected",
          processId,
        });
      })
      .catch(() => {
        // The next `open` retries; don't transition on a failed probe.
      });
  });
  opts.ws.addEventListener("close", () => {
    if (connectCount > 0) setLifecycle({ kind: "disconnected" });
  });
  return {
    lifecycle,
    status: () => statusOf(lifecycle().kind),
    serverProcessId: () => {
      const e = lifecycle();
      return "processId" in e ? e.processId : undefined;
    },
  };
}

/** The headless model `useSurfaceApp()` returns. */
export interface SurfaceAppModel<
  T extends { commit: string } = { commit: string },
> {
  /** Connection lifecycle — build-skew is one facet of the same relationship. */
  status: Accessor<ConnectionStatus>;
  /** This browser's build is provably behind the server's. */
  stale: Accessor<boolean>;
  /** What am I bound to — whatever the buildInfo cell carries (commit, …). */
  server: Accessor<T | undefined>;
  /** This client's baked-in commit. */
  clientCommit: string;
  /** Land the deployed build. */
  reload: () => void;
  /** Set an attention/unread count: OS app badge if installed (best-effort) +
   *  the document title — degrades per browser. Pass 0 to clear. */
  setAttention: (count: number) => void;
}

/** The structural slice of a surface client the provider needs: a `buildInfo`
 *  server cell whose `.use({ authority: "server" })` yields the build identity.
 *  Typing `controlPlane` against this (rather than `any`) makes passing a client
 *  whose surface lacks `buildInfo` a compile error — the "wrong control plane"
 *  mistake (drishti's admin client vs. its per-host clients). A real
 *  `SurfaceClient<S>` from `@kolu/surface` whose surface composes
 *  `...buildInfo.cells` satisfies this. The read is `{ authority: "server" }`:
 *  `buildInfo` is a server cell, so `{ initial }` (the local-authority shape) is
 *  wrong for it. */
export interface ControlPlane<
  T extends { commit: string } = { commit: string },
> {
  cells: {
    buildInfo: {
      use(opts?: { authority?: "server"; onError?: (err: Error) => void }): {
        value: Accessor<T | undefined>;
      };
    };
  };
}

const SurfaceAppContext = createContext<SurfaceAppModel>();

export interface SurfaceAppProviderProps<
  T extends { commit: string } = { commit: string },
  P extends ServerProbe = ServerProbe,
> {
  /** Your control-plane surface client (the one carrying the global buildInfo
   *  cell — for a many-client app, not a per-entity client). Constrained to a
   *  client whose surface carries `buildInfo`, so the wrong client is a compile
   *  error rather than a silent runtime read. */
  controlPlane: ControlPlane<T>;
  /** This client's baked-in commit (your bundler define — e.g. injected by the
   *  surface-app commit stamp as `__SURFACE_APP_COMMIT__`). */
  clientCommit: string;
  /** The build-identity fragment — defaults to `{ commit }`. Pass your extended
   *  one (e.g. kolu's pty-host axis) to drive `stale` off it. */
  buildInfo?: BuildInfoDef<T>;
  /** Override the stale predicate at render time. Defaults to the fragment's
   *  `isStale` (`buildInfo.isStale`); pass this to vary staleness per UI section
   *  (e.g. a stricter rail vs. a lenient badge) without redefining the fragment. */
  isStale?: (server: T | undefined, clientCommit: string) => boolean;
  /** The WebSocket transport. surface-app derives the connection lifecycle from
   *  its open/close; pair with `probe` to tell a transient drop from a restart.
   *  Omit both and `status()` stays `"live"`. */
  ws?: WsLike;
  /** Reads the server's `processId` on each (re)connect — distinguishes
   *  `reconnected` from `restarted`. Pair with `ws`. Generic over the probe
   *  response `P` (a superset of `{ processId }`) for forward compatibility. */
  probe?: () => Promise<P>;
  children: JSX.Element;
}

const baseTitle = typeof document !== "undefined" ? document.title : "";

function setAttention(count: number): void {
  // OS app badge — installed Chromium (Win/macOS) etc.; no-op elsewhere. Do not
  // gate on install state — feature-detect and call; if it works, it works.
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (count > 0) void nav.setAppBadge?.(count).catch(() => {});
  else void nav.clearAppBadge?.().catch(() => {});
  // Document title — the universal fallback (the in-browser-tab case).
  if (typeof document !== "undefined") {
    document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
  }
}

/** Provide the headless app-shell model to the tree. Render your chrome from
 *  `useSurfaceApp()` underneath it. */
export function SurfaceAppProvider<
  T extends { commit: string } = { commit: string },
  P extends ServerProbe = ServerProbe,
>(props: SurfaceAppProviderProps<T, P>): JSX.Element {
  const def = (props.buildInfo ?? defaultBuildInfo) as BuildInfoDef<T>;
  // `buildInfo` is a server cell — read it with `{ authority: "server" }`, not
  // the `{ initial }` (local-authority) shape.
  const cell = props.controlPlane.cells.buildInfo.use({ authority: "server" });
  const server = () => cell.value();
  // Derive the connection lifecycle in-library (kolu's rpc.ts, encapsulated):
  // open/close from the transport + a processId probe for reconnected-vs-restarted.
  const ws = props.ws;
  const probe = props.probe;
  const status: Accessor<ConnectionStatus> =
    ws && probe ? createServerLifecycle({ ws, probe }).status : () => "live";
  // Render-time override beats the fragment's predicate; the fragment's
  // `isStale` wants a concrete value, so fall back to the schema default.
  const isStale = (srv: T | undefined): boolean =>
    props.isStale
      ? props.isStale(srv, props.clientCommit)
      : def.isStale(srv ?? def.cells.buildInfo.default, props.clientCommit);
  const model: SurfaceAppModel<T> = {
    status,
    stale: () => isStale(server()),
    server,
    clientCommit: props.clientCommit,
    reload: reloadForUpdate,
    setAttention,
  };
  return createComponent(SurfaceAppContext.Provider, {
    value: model as SurfaceAppModel,
    get children() {
      return props.children;
    },
  });
}

/** Read the headless app-shell model. Must be used under `<SurfaceAppProvider>`. */
export function useSurfaceApp<
  T extends { commit: string } = { commit: string },
>(): SurfaceAppModel<T> {
  const model = useContext(SurfaceAppContext);
  if (!model) {
    throw new Error("useSurfaceApp must be used within <SurfaceAppProvider>");
  }
  return model as SurfaceAppModel<T>;
}
