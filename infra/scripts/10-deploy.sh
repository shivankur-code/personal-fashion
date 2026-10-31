#!/usr/bin/env bash
# Step 1-3: preview, then deploy the Bicep template. Secrets come from the shell, never from files.
# Usage: ENV=dev ANTHROPIC_API_KEY=... DATABASE_URL=... ./10-deploy.sh [--apply]
#        ENV=beta ANTHROPIC_API_KEY=... PG_ADMIN_PASSWORD=... DATABASE_URL=... ./10-deploy.sh [--apply]
set -euo pipefail
ENV=${ENV:?set ENV to dev or beta}
RG=rg-stylist-$ENV
HERE=$(cd "$(dirname "$0")/../bicep" && pwd)
NAME=stylist-$ENV-$(date +%Y%m%d%H%M)

PARAMS=(-p "$HERE/$ENV.bicepparam" -p anthropicApiKey="${ANTHROPIC_API_KEY:-}" -p databaseUrl="${DATABASE_URL:-}")
if [ "$ENV" != "dev" ]; then
  PARAMS+=(-p pgAdminPassword="${PG_ADMIN_PASSWORD:?set PG_ADMIN_PASSWORD}")
fi

echo "[1.1] offline compile"
az bicep build -f "$HERE/main.bicep" --stdout > /dev/null

echo "[1.2] preview (what-if): shows creates/changes, applies nothing"
az deployment group what-if -g "$RG" -n "$NAME" -f "$HERE/main.bicep" "${PARAMS[@]}" --result-format FullResourcePayloads

if [ "${1:-}" != "--apply" ]; then
  echo "Preview only. Re-run with --apply after reviewing."
  exit 0
fi

echo "[1.3] deploy"
az deployment group create -g "$RG" -n "$NAME" -f "$HERE/main.bicep" "${PARAMS[@]}" \
  --query "properties.{state:provisioningState, outputs:outputs}" -o json
