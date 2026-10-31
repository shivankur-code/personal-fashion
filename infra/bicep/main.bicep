// Stylist MVP infrastructure: one resource group, East US 2, cost-first.
// Deploy:  az deployment group what-if -g <rg> -f main.bicep -p <env>.bicepparam
targetScope = 'resourceGroup'

@description('Short environment name: dev or beta or prod.')
@allowed(['dev', 'beta', 'prod'])
param env string

param location string = resourceGroup().location
param prefix string = 'stylist'

@description('Email that receives budget alerts.')
param ownerEmail string

@description('Monthly budget in USD for this resource group.')
param monthlyBudget int = 30

@description('Budget start: first day of the current month, yyyy-MM-01.')
param budgetStartDate string

@description('Create PostgreSQL in Azure. False for dev (Docker + Neon free).')
param createPostgres bool = false

param pgAdminLogin string = 'stylistadmin'

@secure()
@description('PostgreSQL admin password. Only used when createPostgres is true.')
param pgAdminPassword string = ''

@description('Existing container registry (reused, not created).')
param acrName string = 'myuniquebioregistry'
param acrResourceGroup string = 'MolecularGlue-RG'

@description('Existing Foundry resource that hosts FLUX.2 (reused, not created).')
param foundryName string = '1996shivankursharma-162-resource'
param foundryResourceGroup string = 'cloud-shell-storage-centralindia'

@description('Chrome extension origin allowed to upload photos, e.g. chrome-extension://abcdef...')
param extensionOrigin string

@description('Images. The first deploy uses a public hello-world image until CI pushes ours.')
param apiImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param workerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@secure()
@description('API key for the reasoning model provider (OpenRouter). Passed from the shell, never stored in files.')
param llmApiKey string = ''

@secure()
@description('Access code for the /try page. Empty disables the page (fail closed).')
param tryAccessCode string = ''

@description('Google accounts allowed to use the extension (comma-separated; "*" = any). Empty = nobody.')
param allowedEmails string = ''

@description('Most try-ons per day per API copy.')
param tryDailyLimit int = 30

@description('Reasoning model provider and endpoint.')
param llmProvider string = 'openrouter'
param llmBaseUrl string = 'https://openrouter.ai/api/v1'

@secure()
@description('Postgres connection string. In dev this points at Neon; in beta at the Azure server.')
param databaseUrl string = ''

@description('Entra External ID tenant ID (customer tenant). Empty until Phase C.')
param entraTenantId string = ''

@description('Client ID of the stylist-api app registration. Empty until Phase C.')
param entraAudience string = ''

@description('Deploy the worker and scheduled jobs. False in dev so Neon free can sleep; workers run locally.')
param enableBackgroundCompute bool = true

param apiMinReplicas int = 0
param apiMaxReplicas int = 3
param workerMaxReplicas int = 4

var name = '${prefix}-${env}'
var tags = {
  project: prefix
  env: env
  owner: ownerEmail
}
var roleStorageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// 1. Network: free. Container Apps needs a delegated subnet of at least /27.
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${name}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.20.0.0/16'] }
    subnets: [
      {
        name: 'aca'
        properties: {
          addressPrefix: '10.20.0.0/24'
          delegations: [ { name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } } ]
        }
      }
      {
        name: 'pg'
        properties: {
          addressPrefix: '10.20.1.0/27'
          delegations: [ { name: 'pg', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } } ]
        }
      }
    ]
  }
}

// 2. Logs: daily cap keeps ingestion inside the free 5 GB a month.
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.15') }
  }
}

// 3. Storage for photos, product images, results and exports.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: toLower(replace('${prefix}${env}${uniqueString(resourceGroup().id)}', '-', ''))
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: [extensionOrigin]
          allowedMethods: ['PUT', 'GET', 'HEAD']
          allowedHeaders: ['x-ms-blob-type', 'x-ms-blob-content-type', 'content-type', 'x-ms-version']
          exposedHeaders: ['etag']
          maxAgeInSeconds: 3600
        }
      ]
    }
    deleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for c in ['photos', 'products', 'results', 'exports']: {
  parent: blobService
  name: c
  properties: { publicAccess: 'None' }
}]

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-unsaved-results'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['results/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } } }
          }
        }
        {
          name: 'expire-exports'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['exports/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 7 } } }
          }
        }
      ]
    }
  }
}

// 4. One identity for every app and job.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-id'
  location: location
  tags: tags
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, identity.id, roleStorageBlobDataContributor)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleStorageBlobDataContributor)
  }
}

module acrPull 'modules/acr-pull.bicep' = {
  name: '${name}-acrpull'
  scope: resourceGroup(acrResourceGroup)
  params: { acrName: acrName, principalId: identity.properties.principalId }
}

module foundryUser 'modules/foundry-user.bicep' = {
  name: '${name}-foundry'
  scope: resourceGroup(foundryResourceGroup)
  params: { foundryName: foundryName, principalId: identity.properties.principalId }
}

// 5. PostgreSQL (beta and prod only). Private access through the delegated subnet.
resource pgDns 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createPostgres) {
  name: '${name}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource pgDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createPostgres) {
  parent: pgDns
  name: '${name}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (createPostgres) {
  name: '${name}-pg'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    administratorLogin: pgAdminLogin
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: '${vnet.id}/subnets/pg'
      privateDnsZoneArmResourceId: pgDns.id
    }
  }
  dependsOn: [pgDnsLink]
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (createPostgres) {
  parent: pg
  name: 'stylist'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// 6. Web PubSub Free tier: 20 connections, 20,000 messages a day.
resource pubsub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: '${name}-pubsub'
  location: location
  tags: tags
  sku: { name: 'Free_F1', tier: 'Free', capacity: 1 }
  properties: {}
}

// 7. Container Apps environment: Consumption profile only (no dedicated profile,
// no private endpoint, no maintenance window, so no management fee).
resource acaEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  tags: tags
  properties: {
    workloadProfiles: [ { name: 'Consumption', workloadProfileType: 'Consumption' } ]
    vnetConfiguration: { infrastructureSubnetId: '${vnet.id}/subnets/aca', internal: false }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var acrServer = '${acrName}.azurecr.io'
var usesAcr = startsWith(apiImage, acrServer)
var commonSecrets = [
  { name: 'llm-api-key', value: empty(llmApiKey) ? 'unset' : llmApiKey }
  { name: 'database-url', value: empty(databaseUrl) ? 'unset' : databaseUrl }
  { name: 'pubsub-connection', value: pubsub.listKeys().primaryConnectionString }
]
var commonEnv = [
  { name: 'APP_ENV', value: env }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'STORAGE_ACCOUNT', value: storage.name }
  { name: 'FOUNDRY_ENDPOINT', value: 'https://${foundryName}.cognitiveservices.azure.com/' }
  { name: 'LLM_PROVIDER', value: llmProvider }
  { name: 'LLM_BASE_URL', value: llmBaseUrl }
  { name: 'LLM_API_KEY', secretRef: 'llm-api-key' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'PUBSUB_CONNECTION', secretRef: 'pubsub-connection' }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
  { name: 'ENTRA_ISSUER', value: empty(entraTenantId) ? '' : 'https://${entraTenantId}.ciamlogin.com/${entraTenantId}/v2.0' }
  { name: 'ENTRA_AUDIENCE', value: entraAudience }
]
var registries = usesAcr ? [ { server: acrServer, identity: identity.id } ] : []
// Microsoft's placeholder image listens on port 80 and has no health routes.
var isPlaceholder = startsWith(apiImage, 'mcr.microsoft.com/k8se/quickstart')
var apiPort = isPlaceholder ? 80 : 8080
var apiProbes = isPlaceholder ? [] : [
  { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }
  { type: 'Readiness', httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 10 }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${name}-api'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: acaEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      // Single: a new version gets traffic only after it passes its readiness check; the old one
      // keeps serving until then (zero-downtime). Rollback = redeploy the previous image tag.
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: apiPort, transport: 'auto', allowInsecure: false }
      secrets: concat(commonSecrets, [ { name: 'try-access-code', value: empty(tryAccessCode) ? 'unset' : tryAccessCode } ])
      registries: registries
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(commonEnv, [
            { name: 'PG_POOL_MAX', value: '5' }
            { name: 'TRY_ACCESS_CODE', secretRef: 'try-access-code' }
            { name: 'TRY_DAILY_LIMIT', value: string(tryDailyLimit) }
            { name: 'ALLOWED_EMAILS', value: allowedEmails }
          ])
          probes: apiProbes
        }
      ]
      scale: {
        minReplicas: apiMinReplicas
        maxReplicas: apiMaxReplicas
        rules: [ { name: 'http', http: { metadata: { concurrentRequests: '50' } } } ]
      }
    }
  }
  dependsOn: [acrPull]
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = if (enableBackgroundCompute) {
  name: '${name}-worker'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: acaEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: commonSecrets
      registries: registries
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(commonEnv, [ { name: 'PG_POOL_MAX', value: '3' } ])
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: workerMaxReplicas
        // KEDA PostgreSQL scaler: one replica per 5 waiting pg-boss jobs.
        rules: [
          {
            name: 'pending-jobs'
            custom: {
              type: 'postgresql'
              metadata: {
                // Must match apps/worker/test/jobs.test.ts. Only our queues; internal pg-boss queues excluded.
                query: 'SELECT COUNT(*) FROM pgboss.job WHERE state IN (\'created\', \'retry\') AND name IN (\'job-steps\', \'render\', \'catalog\', \'privacy\')'
                targetQueryValue: '5'
              }
              auth: [ { secretRef: 'database-url', triggerParameter: 'connection' } ]
            }
          }
        ]
      }
    }
  }
  dependsOn: [acrPull]
}

// 8. Jobs. Same worker image, different command.
var jobs = [
  { name: 'migrate', trigger: 'Manual', cron: '', cmd: 'migrate' }
  { name: 'sweeper', trigger: 'Schedule', cron: '*/1 * * * *', cmd: 'sweep' }
  { name: 'grants', trigger: 'Schedule', cron: '5 0 1 * *', cmd: 'grant-monthly-credits' }
  { name: 'cleanup', trigger: 'Schedule', cron: '15 3 * * *', cmd: 'cleanup' }
  { name: 'health', trigger: 'Schedule', cron: '*/5 * * * *', cmd: 'healthcheck' }
]

resource jobRes 'Microsoft.App/jobs@2024-03-01' = [for j in jobs: if (enableBackgroundCompute || j.trigger == 'Manual') {
  name: '${name}-${j.name}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: acaEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: j.trigger
      replicaTimeout: 300
      replicaRetryLimit: 1
      manualTriggerConfig: j.trigger == 'Manual' ? { parallelism: 1, replicaCompletionCount: 1 } : null
      scheduleTriggerConfig: j.trigger == 'Schedule' ? { cronExpression: j.cron, parallelism: 1, replicaCompletionCount: 1 } : null
      secrets: commonSecrets
      registries: registries
    }
    template: {
      containers: [
        {
          name: j.name
          image: workerImage
          args: ['job', j.cmd]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(commonEnv, [ { name: 'PG_POOL_MAX', value: '1' } ])
        }
      ]
    }
  }
  dependsOn: [acrPull]
}]

// 9. Budget with email alerts at 50%, 80% and 100% of actual spend.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${name}-budget'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      at50: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 50, contactEmails: [ownerEmail], thresholdType: 'Actual' }
      at80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, contactEmails: [ownerEmail], thresholdType: 'Actual' }
      at100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, contactEmails: [ownerEmail], thresholdType: 'Actual' }
    }
  }
}

output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output storageAccount string = storage.name
output identityClientId string = identity.properties.clientId
output pubsubName string = pubsub.name
output postgresHost string = pg.?properties.fullyQualifiedDomainName ?? 'not created (dev uses Docker + Neon free)'
