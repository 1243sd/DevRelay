#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then echo 'Already running'; exit 1; fi
nohup node dist/server.js >> data/server.log 2>&1 < /dev/null &
echo $! > data/server.pid
echo "PID $(cat data/server.pid); log: data/server.log"
