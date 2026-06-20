#!/bin/bash
set -e
cd "$(dirname "$0")"
node test-publish.js
echo "All publish tests passed!"