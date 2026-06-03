/**
 * Hello-world chrome, rendered from surface-app's headless model.
 *
 * The library ships NO styled components — this rail/badge/prompt is the app's
 * own CSS, built from `useSurfaceApp()`. The same model drives kolu's tailwind
 * chrome and drishti's; only the pixels differ.
 */

import { createSignal, Show } from "solid-js";
import { SurfaceAppProvider, useSurfaceApp } from "@kolu/surface-app/solid";
import { app, connectionStatus } from "./wire";

const STATUS_LABEL: Record<string, string> = {
  live: "live",
  reconnecting: "reconnecting…",
  restarted: "server restarted",
  down: "down",
};

function Shell() {
  const pwa = useSurfaceApp();
  const [count, setCount] = createSignal(0);
  const ping = () => {
    const n = count() + 1;
    setCount(n);
    pwa.setAttention(n);
  };

  return (
    <>
      <header class="rail">
        <span class={`dot ${pwa.status() === "live" ? "ok" : "warn"}`} />
        <span class="muted">{STATUS_LABEL[pwa.status()] ?? pwa.status()}</span>
        <span class="sep">·</span>
        <span>
          SRV <b class="srv">{pwa.server()?.commit || "…"}</b>
        </span>
        <span class="sep">·</span>
        <span>
          CLIENT <b class="cli">{pwa.clientCommit}</b>
        </span>
        <Show when={pwa.stale()}>
          <span class="chip">≠ srv</span>
          <button type="button" class="reload" onClick={pwa.reload}>
            ⟳ Reload
          </button>
        </Show>
      </header>

      <main class="body">
        <h1>@kolu/surface-app</h1>
        <p class="lead">
          The app shell for surface apps. This client is bound to a server over
          the live wire; its build identity rides a <code>buildInfo</code>{" "}
          surface cell, and the rail above is rendered from the headless{" "}
          <code>useSurfaceApp()</code> model.
        </p>

        <Show
          when={pwa.stale()}
          fallback={<p class="ok-text">✓ In step with the server.</p>}
        >
          <p class="warn-text">
            This tab is running an <b>older build</b> than the server — the rail
            shows <code>≠ srv</code> and a one-tap <b>Reload</b>. (Server{" "}
            <code>{pwa.server()?.commit}</code> ≠ client{" "}
            <code>{pwa.clientCommit}</code>.)
          </p>
        </Show>

        <button type="button" class="ping" onClick={ping}>
          Ping → setAttention({count() + 1})
        </button>
        <p class="muted small">
          <code>setAttention()</code> sets the OS app badge (installed Chromium)
          and the document title — watch the tab title change.
        </p>
      </main>
    </>
  );
}

export default function App() {
  return (
    <SurfaceAppProvider
      controlPlane={app}
      clientCommit={__SURFACE_APP_COMMIT__}
      status={connectionStatus}
    >
      <Shell />
    </SurfaceAppProvider>
  );
}
