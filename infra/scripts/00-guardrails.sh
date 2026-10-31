#!/usr/bin/env bash
# Step 0: guardrails. No-cost actions only. Safe to re-run.
# Usage: ENV=dev ./00-guardrails.sh
set -euo pipefail
SUB=4b37c323-30b2-4684-88ff-ba5cdc3467f9
ENV=${ENV:?set ENV to dev or beta}
RG=rg-stylist-$ENV
LOC=eastus2
OWNER=${OWNER:-harshvardhanguptaus@gmail.com}

echo "[0.1] select subscription"
az account set --subscription "$SUB"
az account show --query "{name:name, spendingLimit:id}" -o table

echo "[0.2] confirm spending limit is still On"
az rest --method get --url "https://management.azure.com/subscriptions/$SUB?api-version=2022-12-01" \
  --query "subscriptionPolicies.spendingLimit" -o tsv

echo "[0.3] register only the providers the MVP needs (free)"
for p in Microsoft.App Microsoft.OperationalInsights Microsoft.SignalRService Microsoft.Network Microsoft.ManagedIdentity Microsoft.Consumption; do
  az provider register -n "$p" --wait
  printf '  %-32s %s\n' "$p" "$(az provider show -n "$p" --query registrationState -o tsv)"
done
if [ "$ENV" != "dev" ]; then
  az provider register -n Microsoft.DBforPostgreSQL --wait
fi

echo "[0.4] resource group with cost tags"
az group create -n "$RG" -l "$LOC" --tags project=stylist env="$ENV" owner="$OWNER" -o table
