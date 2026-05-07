import tailwindcss from "@tailwindcss/vite";
import xtermPackage from "@xterm/xterm/package.json" with { type: "json" };
import { DEFAULT_PORT } from "kolu-common/config";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const commitHash = process.env.KOLU_COMMIT_HASH || "dev";
const xtermVersion = xtermPackage.version;

const fontsDir = process.env.KOLU_FONTS_DIR;
if (!fontsDir) {
  throw new Error(
    "KOLU_FONTS_DIR env var is not set. Run inside the Nix devShell (just dev).",
  );
}

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "kolu-fonts": `${fontsDir}/fonts.css`,
    },
  },
  server: {
    port: 5173,
    // Prevent browser from caching dev assets — stale modules cause subtle bugs on refresh.
    headers: { "Cache-Control": "no-store" },
    proxy: {
      "/api": `http://localhost:${DEFAULT_PORT}`,
      "/manifest.webmanifest": `http://localhost:${DEFAULT_PORT}`,
      "/rpc": {
        target: `http://localhost:${DEFAULT_PORT}`,
        ws: true,
      },
    },
  },
  define: {
    __KOLU_COMMIT__: JSON.stringify(commitHash),
    __XTERM_VERSION__: JSON.stringify(xtermVersion),
  },
  build: {
    target: "esnext",
  },
});
