#!/usr/bin/env bash
# Self-check for the Planning node (/plan).
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "FAIL: node not installed" >&2; exit 1; }
node test-planning.js