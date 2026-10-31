#!/usr/bin/env bash
# Step 4: verify every component after a deploy. Read-only. Prints PASS or FAIL per check.
# Usage: ENV=dev ./20-verify.sh
set -uo pipefail
ENV=${ENV:?set ENV}
RG=rg-stylist-$ENV
N=stylist-$ENV
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1: got '$2', want '$3'"; fail=1; fi; }

check "log cap 0.15 GB/day" "$(az monitor log-analytics workspace show -g $RG -n $N-logs --query workspaceCapping.dailyQuotaGb -o tsv)" "0.15"
SA=$(az storage account list -g $RG --query "[0].name" -o tsv)
check "blob public access off" "$(az storage account show -n $SA --query allowBlobPublicAccess -o tsv)" "false"
check "shared key access off" "$(az storage account show -n $SA --query allowSharedKeyAccess -o tsv)" "false"
check "4 containers" "$(az storage container list --account-name $SA --auth-mode login --query 'length(@)' -o tsv)" "4"
check "lifecycle rules" "$(az storage account management-policy show -g $RG --account-name $SA --query 'length(policy.rules)' -o tsv)" "2"
check "web pubsub free tier" "$(az resource show -g $RG -n $N-pubsub --resource-type Microsoft.SignalRService/webPubSub --query sku.name -o tsv)" "Free_F1"
check "env has no dedicated profile" "$(az containerapp env show -g $RG -n $N-env --query "length(properties.workloadProfiles[?workloadProfileType!='Consumption'])" -o tsv)" "0"
check "api running" "$(az containerapp show -g $RG -n $N-api --query properties.runningStatus -o tsv)" "Running"
URL=https://$(az containerapp show -g $RG -n $N-api --query properties.configuration.ingress.fqdn -o tsv)
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 $URL/healthz)
[ "$CODE" = "200" ] || CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 $URL/)  # placeholder image has no /healthz
check "api https responds" "$CODE" "200"
check "budget exists" "$(az consumption budget list --resource-group $RG --query 'length(@)' -o tsv)" "1"
if [ "$ENV" != "dev" ]; then
  check "postgres B1ms" "$(az postgres flexible-server show -g $RG -n $N-pg --query sku.name -o tsv)" "Standard_B1ms"
  check "postgres private" "$(az postgres flexible-server show -g $RG -n $N-pg --query network.publicNetworkAccess -o tsv)" "Disabled"
  check "worker min replicas 0" "$(az containerapp show -g $RG -n $N-worker --query properties.template.scale.minReplicas -o tsv)" "0"
fi
exit $fail
