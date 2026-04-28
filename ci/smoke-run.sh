#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
kolu_bin="$(nix build "$root#default" --print-out-paths --no-link)/bin/kolu"
port="$(
  node --input-type=module <<'NODE'
import { createServer } from "node:net";

const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  console.log(address.port);
  server.close();
});
NODE
)"

scratch="$(mktemp -d)"
log="$scratch/kolu.log"
kolu_pid=""

cleanup() {
  if [[ -n "$kolu_pid" ]] && kill -0 "$kolu_pid" 2>/dev/null; then
    kill "$kolu_pid" 2>/dev/null || true
    wait "$kolu_pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

XDG_CONFIG_HOME="$scratch/config" "$kolu_bin" \
  --host 127.0.0.1 \
  --port "$port" \
  >"$log" 2>&1 &
kolu_pid="$!"

for _ in {1..80}; do
  if node --input-type=module - "http://127.0.0.1:$port/api/health" <<'NODE'
const url = process.argv.at(-1);
try {
  const response = await fetch(url);
  const body = await response.text();
  process.exit(response.ok && body === "kolu" ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
  then
    echo "kolu health check passed on 127.0.0.1:$port"
    exit 0
  fi

  if ! kill -0 "$kolu_pid" 2>/dev/null; then
    cat "$log" >&2
    wait "$kolu_pid"
  fi

  sleep 0.25
done

cat "$log" >&2
echo "kolu did not become healthy on 127.0.0.1:$port" >&2
exit 1
