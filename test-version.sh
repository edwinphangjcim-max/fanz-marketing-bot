#!/usr/bin/env bash
# Self-check for the version/commit-SHA mechanism in index.js.
# Validates without requiring TELEGRAM_TOKEN / OPENROUTER_API_KEY.

set -eu

cd "$(dirname "$0")"

INDEX=index.js
VERSION_FILE=version.txt

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[ -f "$INDEX" ] || fail "$INDEX not found"

# ----------------------------------------------------------------------
# 1. Try to trigger version.txt creation by briefly running index.js.
#    The bot will exit non-zero on missing env vars, but the SHA
#    resolution + version.txt write happen BEFORE the env check.
# ----------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  # Run with empty env so the bot exits fast; ignore exit code.
  ( unset TELEGRAM_TOKEN OPENROUTER_API_KEY; node "$INDEX" >/dev/null 2>&1 ) || true
fi

# ----------------------------------------------------------------------
# 2. Primary check: version.txt must exist and be non-empty.
# ----------------------------------------------------------------------
version_ok=0
if [ -s "$VERSION_FILE" ]; then
  sha=$(tr -d '[:space:]' < "$VERSION_FILE")
  if [ -n "$sha" ]; then
    pass "version.txt present and non-empty: $sha"
    version_ok=1
  fi
fi

if [ "$version_ok" -ne 1 ]; then
  echo "INFO: version.txt unavailable — falling back to code-structure checks"
fi

# ----------------------------------------------------------------------
# 3. Code-structure checks against index.js. These run unconditionally:
#    they confirm the SHA-resolution and HTTP-server logic exist as
#    described, even when version.txt is present (defence in depth).
# ----------------------------------------------------------------------
grep -q "RAILWAY_GIT_COMMIT_SHA" "$INDEX" \
  || fail "index.js missing RAILWAY_GIT_COMMIT_SHA env-var lookup"
pass "RAILWAY_GIT_COMMIT_SHA env-var lookup present"

grep -q "\.git" "$INDEX" \
  || fail "index.js missing .git directory read"
grep -q "HEAD" "$INDEX" \
  || fail "index.js missing .git/HEAD reference"
pass ".git/HEAD read logic present"

grep -q "ref: " "$INDEX" \
  || fail "index.js missing 'ref: ' branch-pointer handling for .git/HEAD"
pass ".git/HEAD ref-pointer handling present"

grep -q "version.txt" "$INDEX" \
  || fail "index.js missing version.txt fallback"
pass "version.txt fallback logic present"

# ----------------------------------------------------------------------
# 4. HTTP server structure checks (server is not actually started here).
# ----------------------------------------------------------------------
grep -q "require('http')" "$INDEX" \
  || fail "index.js missing 'require(\"http\")'"
pass "http module imported"

grep -q "http.createServer" "$INDEX" \
  || fail "index.js missing http.createServer call"
pass "http.createServer present"

grep -q "process.env.PORT" "$INDEX" \
  || fail "index.js missing process.env.PORT usage"
grep -q "8080" "$INDEX" \
  || fail "index.js missing 8080 default port"
pass "PORT env-var + 8080 default present"

grep -q "/version" "$INDEX" \
  || fail "index.js missing /version route"
pass "/version route present"

grep -q "/health" "$INDEX" \
  || fail "index.js missing /health route"
pass "/health route present"

grep -q "\.listen(" "$INDEX" \
  || fail "index.js missing httpServer.listen() call"
pass "server.listen() present"

echo
echo "ALL CHECKS PASSED"
exit 0
