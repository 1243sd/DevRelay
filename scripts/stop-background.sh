#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f data/server.pid ]; then kill "$(cat data/server.pid)"; rm data/server.pid; fi
