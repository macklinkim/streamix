#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: bootstrap.sh <web-host> <api-host> <media-host>" >&2
  exit 2
fi

web_host="$1"
api_host="$2"
media_host="$3"
repo=/opt/streamix

cd "$repo"
git pull --ff-only origin main

if [[ -f .env ]]; then
  # Root-owned file generated below; values are hex or hostnames only.
  source .env
fi

umask 077
db_password="${STREAMIX_DB_PASSWORD:-$(openssl rand -hex 24)}"
jwt_secret="${STREAMIX_JWT_SECRET:-$(openssl rand -hex 32)}"
playback_secret="${STREAMIX_PLAYBACK_SECRET:-$(openssl rand -hex 32)}"
internal_token="${STREAMIX_INTERNAL_TOKEN:-$(openssl rand -hex 32)}"
metrics_token="${STREAMIX_METRICS_TOKEN:-$(openssl rand -hex 32)}"
cat > .env <<EOF
STREAMIX_DB_PASSWORD=${db_password}
STREAMIX_JWT_SECRET=${jwt_secret}
STREAMIX_PLAYBACK_SECRET=${playback_secret}
STREAMIX_INTERNAL_TOKEN=${internal_token}
STREAMIX_METRICS_TOKEN=${metrics_token}
STREAMIX_WEB_HOST=${web_host}
STREAMIX_API_HOST=${api_host}
STREAMIX_MEDIA_HOST=${media_host}
EOF

docker compose -f infra/hetzner/docker-compose.yml up -d --build

for _ in {1..90}; do
  if curl -fsS http://127.0.0.1:8180/health >/dev/null \
      && curl -fsS http://127.0.0.1:3000/ >/dev/null; then
    exit 0
  fi
  sleep 10
done

echo "Streamix did not become healthy within 15 minutes" >&2
docker compose -f infra/hetzner/docker-compose.yml ps >&2
exit 1
