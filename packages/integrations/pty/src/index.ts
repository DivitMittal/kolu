/** kolu-pty — shell-integration primitives.
 *
 *  Env layering (`cleanEnv` / `koluIdentityEnv`) and the injected
 *  wrapper rcfile that makes a spawned shell emit OSC 7 (cwd), OSC 0/2
 *  (title), and OSC 633;E (preexec command) — the signals kolu's
 *  metadata providers consume. The caller owns where the rc files live
 *  (`rcDir`) and supplies a `TERM_PROGRAM_VERSION` string.
 *
 *  The PTY-owning half (node-pty + @xterm/headless behind a
 *  `PtyHandle`) moved to `@kolu/pty-host` in R-4 — this package no
 *  longer spawns PTYs, it only prepares the environment a PTY runs in.
 *  Only dep on kolu-* is `kolu-shared` (the `Logger` type). */

export {
  cleanEnv,
  configureNixShellEnv,
  koluIdentityEnv,
  NIX_ENV_WHITELIST,
  prepareShellInit,
} from "./shell.ts";
