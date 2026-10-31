#!/usr/bin/env bash
# Step 1-3: preview, then deploy the Bicep template. Secrets come from the shell, never from files.
# Usage: ENV=dev ANTHROPIC_API_KEY=... DATABASE_URL=... [IMAGE_TAG=<git sha>] ./10-deploy.sh [--apply]
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
# Images: IMAGE_TAG if given; otherwise keep whatever our registry image is live now, so an
# infrastructure-only change never puts the placeholder image back.
REG=${ACR_NAME:-myuniquebioregistry}.azurecr.io
if [ -z "${IMAGE_TAG:-}" ]; then
  # Any failure to read the live state stops the script: a network blip must never downgrade the API.
  if ! LIVE=$(az containerapp list -g "$RG" --query "[?name=='stylist-$ENV-api'].properties.template.containers[0].image | [0]" -o tsv); then
    echo "Could not read the live API image. Re-run, or set IMAGE_TAG explicitly." >&2
    exit 1
  fi
  case "$LIVE" in
    "$REG/stylist-api:"*) IMAGE_TAG=${LIVE##*:}; echo "[1.0] keeping live image tag $IMAGE_TAG" ;;
    "") echo "[1.0] API not created yet; using the template's placeholder image" ;;
    *) echo "Live API image is '$LIVE' (not ours). Set IMAGE_TAG explicitly." >&2; exit 1 ;;
  esac
fi
if [ -n "${IMAGE_TAG:-}" ]; then
  PARAMS+=(-p apiImage="$REG/stylist-api:$IMAGE_TAG" -p workerImage="$REG/stylist-worker:$IMAGE_TAG")
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
