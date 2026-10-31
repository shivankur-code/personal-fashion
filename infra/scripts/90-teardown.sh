#!/usr/bin/env bash
# Removes one environment completely. Shared resources (ACR, Foundry) are untouched,
# but the role assignments this project added to them are removed first.
# Usage: ENV=dev ./90-teardown.sh --yes
set -euo pipefail
ENV=${ENV:?set ENV}
RG=rg-stylist-$ENV
[ "${1:-}" = "--yes" ] || { echo "Refusing without --yes"; exit 1; }
PID=$(az identity show -g $RG -n stylist-$ENV-id --query principalId -o tsv 2>/dev/null || true)
if [ -n "$PID" ]; then
  az role assignment delete --assignee-object-id "$PID" --scope "$(az acr show -n myuniquebioregistry --query id -o tsv)" || true
  az role assignment delete --assignee-object-id "$PID" --scope "$(az cognitiveservices account show -g cloud-shell-storage-centralindia -n 1996shivankursharma-162-resource --query id -o tsv)" || true
fi
az group delete -n "$RG" --yes --no-wait
echo "Deletion started for $RG. Check: az group show -n $RG"
