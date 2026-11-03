#!/usr/bin/env bash
# FR-SVR-012/013/016: build the image, then check user, read-only start, health, restart with the same volume,
# and that a second container on the same volume is refused. Run: bash scripts/docker-smoke.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows rewrites /tmp and /data otherwise
IMG=dbloom-smoke
VOL=dbloom-smoke-data
NAME=dbloom-smoke-1
ENVS=(-e DBLOOM_PUBLIC_ORIGIN=https://dbloom.example.test -e DBLOOM_TRUST_PROXY=172.16.0.0/12 -e DBLOOM_DIRECT_FREE_FORM_ACK=true)
RUN=(--read-only --tmpfs /tmp -v "$VOL:/data" "${ENVS[@]}")
cleanup() { docker rm -f "$NAME" "$NAME-2" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker build -t "$IMG" --build-arg VERSION=smoke .
docker image inspect "$IMG" --format 'size={{.Size}} layers={{len .RootFS.Layers}}'
uid=$(docker run --rm --entrypoint id "$IMG" -u)
[ "$uid" != "0" ] || { echo "FAIL: image runs as root"; exit 1; }

wait_healthy() {
  for _ in $(seq 1 60); do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo none)
    [ "$s" = healthy ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$1")" = true ] || { docker logs "$1"; return 1; }
    sleep 2
  done
  docker logs "$1"; return 1
}

docker run -d --name "$NAME" "${RUN[@]}" "$IMG" >/dev/null
wait_healthy "$NAME"; echo "ok: healthy with read-only root"

# second instance on the same volume must exit non-zero with a clear message
if docker run --name "$NAME-2" "${RUN[@]}" "$IMG" >/dev/null 2>&1; then echo "FAIL: second instance started"; exit 1; fi
docker logs "$NAME-2" 2>&1 | tail -3
echo "ok: second instance refused"

# graceful stop, then restart on the same volume
docker stop -t 30 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME"); echo "exit code after stop: $code"
docker rm "$NAME" >/dev/null
docker run -d --name "$NAME" "${RUN[@]}" "$IMG" >/dev/null
wait_healthy "$NAME"; echo "ok: restarted on same volume"
