import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The client's baked-in commit. In a real app this is injected by the
// surface-app commit stamp (Vite/Nix) or a Bun define; here we hardcode a value
// DIFFERENT from the server's default so the `≠ srv` skew is visible on first load.
const clientCommit = process.env.CLIENT_COMMIT || "c11e7700";

export default defineConfig({
  root: "src/client",
  define: {
    __SURFACE_APP_COMMIT__: JSON.stringify(clientCommit),
  },
  plugins: [solid()],
  server: {
    port: 5175,
    proxy: {
      "/rpc": { target: "http://127.0.0.1:7710", ws: true },
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
});
