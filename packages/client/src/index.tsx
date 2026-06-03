/// <reference types="vite/client" />

import { retireServiceWorker } from "@kolu/surface-app/lifecycle";
import { SurfaceAppProvider } from "@kolu/surface-app/solid";
import { MetaProvider } from "@solidjs/meta";
import { koluBuildInfo } from "kolu-common/surface";
import { render } from "solid-js/web";
import App from "./App";
import { app, ws } from "./wire";
import "./index.css";

// kolu does not use a service worker. Retire any one a previous build left
// registered (and delete its caches); the self-destructing `/sw.js` (served by
// surface-app's `installFreshStatic`) covers a worker still controlling the
// page. Run before any component — the framework-free `/lifecycle` subpath.
retireServiceWorker();

// Install `window.__kolu` debug hook (dev only) — one-line console access to
// the same diagnostic probes DiagnosticInfo renders. See debug/consoleHooks.ts.
if (import.meta.env.DEV) {
  void import("./debug/consoleHooks").then((m) => m.installDebugHooks());
}

render(
  () => (
    // surface-app's headless app-shell model: the connection lifecycle (derived
    // from `ws` + the `surface.server.info` probe), build-skew staleness (driven
    // by `koluBuildInfo`'s extended cell), and the reload affordance. kolu reads
    // it via `useSurfaceApp()` and renders its own tailwind chrome (IdentityRail,
    // StaleBadge, TransportOverlay, the mobile sheet).
    <SurfaceAppProvider
      controlPlane={app}
      clientCommit={__SURFACE_APP_COMMIT__}
      buildInfo={koluBuildInfo}
      ws={ws}
      probe={() => app.rpc.surface.server.info({})}
    >
      <MetaProvider>
        <App />
      </MetaProvider>
    </SurfaceAppProvider>
  ),
  document.body,
);
