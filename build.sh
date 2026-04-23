#!/usr/bin/env bash
set -euo pipefail

ARCH=$(uname -m)
ARCHTAG="latest-${ARCH}"

cd "$(dirname "$0")"

echo "==> Building openwebrx-base:${ARCHTAG}"
docker build --pull \
  -t openwebrx-base:${ARCHTAG} \
  -f docker/Dockerfiles/Dockerfile-base .

echo "==> Building openwebrx-rtlsdr:${ARCHTAG}"
docker build \
  --build-arg ARCHTAG=${ARCHTAG} \
  -t openwebrx-rtlsdr:${ARCHTAG} \
  -f docker/Dockerfiles/Dockerfile-rtlsdr .

echo ""
echo "Build concluido! Para iniciar:"
echo "  docker compose up -d"
