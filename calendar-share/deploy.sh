#!/bin/bash
# Rebuilds and restarts the public calendar container from the latest master.
# Keeps its compose file and token in a persistent directory, so the running
# container never depends on a temp clone that disappears.
set -euo pipefail

DEPLOY_DIR=/opt/mediaops/calendar-share
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT

git clone --depth 1 --quiet https://github.com/druboni/mediaops-dashboard.git "$SRC"
docker build -t mediaops-calendar-share:latest -f "$SRC/calendar-share/Dockerfile" "$SRC"

mkdir -p "$DEPLOY_DIR"
cp "$SRC/calendar-share/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
if [ ! -s "$DEPLOY_DIR/.env" ]; then
  echo "Missing $DEPLOY_DIR/.env — create it with CALENDAR_TOKEN=<token from MediaOps Settings → Sharing>" >&2
  exit 1
fi
chmod 600 "$DEPLOY_DIR/.env"

docker compose -f "$DEPLOY_DIR/docker-compose.yml" up -d --force-recreate
docker image prune -f >/dev/null
docker ps --filter name=calendar-share
