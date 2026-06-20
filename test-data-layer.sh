#!/usr/bin/env bash
# Self-check for the data layer + state machine.
# Delegates to test-data-layer.js so the assertions live in one place.

set -eu
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "FAIL: node not installed" >&2; exit 1; }

node test-data-layer.js
