# Dev shell — shared by `nix develop` (via flake.nix) and `nix-shell`.
#
# Imports env.nix directly instead of going through default.nix, which also
# defines pnpmDeps/kolu build derivations that are unnecessary for the shell.
#
# Playwright is NOT included here — it adds ~600ms to nix develop cold start.
# flake.nix exposes devShells.e2e for e2e tests: `nix develop .#e2e`.
{ pkgs ? import ./nix/nixpkgs.nix { }
, # The flake self-reference, threaded through from flake.nix so dev
  # KOLU_AGENT_FLAKE_REF points at the same source the flake outputs
  # use. Optional so `nix-shell ./shell.nix` (no flake context) still
  # works — the env var stays unset there and remote terminals
  # surface the "requires KOLU_AGENT_FLAKE_REF" error per the
  # "no fallback by design" contract.
  self ? null
}:
let
  koluEnv = import ./nix/env.nix { inherit pkgs; };
in
pkgs.mkShell {
  name = "kolu-shell";

  env = koluEnv // {
    KOLU_COMMIT_HASH = "dev";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  } // pkgs.lib.optionalAttrs (self != null) {
    # Remote terminals (R-2): the `kolu --stdio` agent's drv path is
    # resolved by `nix eval --raw $KOLU_AGENT_FLAKE_REF#packages.<sys>.default.drvPath`.
    # `self` is the flake's own store-pathed source — same bytes the
    # flake's outputs are built from. Avoids the github: branch ref
    # (which requires push) and the `path:$cwd` shell-expansion that
    # breaks under workspace subdirs.
    KOLU_AGENT_FLAKE_REF = "${self}";
  };

  shellHook = ''
    if root=$(git rev-parse --show-toplevel 2>/dev/null); then
      ln -sfn "$KOLU_FONTS_DIR" "$root/packages/client/public/fonts"
    fi
  '';

  packages = with pkgs; [
    just
    jq # used by ci/lib.just recipes
    nodejs
    pnpm
    tsx
    nixpkgs-fmt
    # Biome from nixpkgs — single toolchain source, avoids per-platform Rust
    # binary fetches via pnpm postinstall. Version drift between this and
    # biome.jsonc's $schema URL is tolerable for IDE auto-complete (#885).
    biome
    # `uv` provides `uvx`, used by agents/ai.just to run APM from
    # git+https without a global install.
    uv
    # prettier is provided by pnpm (same version) — no need for a nix copy.
    # Use `pnpm exec prettier` or ensure `just install` has been run.
    # node-gyp toolchain — required by `pnpm install` to recompile node-pty
    # after applying patches/node-pty@1.1.0.patch (the patched install
    # script forces node-gyp rebuild). The build derivation already lists
    # these in nativeBuildInputs; the dev shell needs them so `just install`
    # works outside the nix build.
    python3
    nodePackages.node-gyp
    pkg-config
  ];
}
