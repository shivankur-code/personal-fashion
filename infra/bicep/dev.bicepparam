using 'main.bicep'

param env = 'dev'
param ownerEmail = 'harshvardhanguptaus@gmail.com'
param monthlyBudget = 30
// First day of the month of the first deployment. Set once; never change it afterwards.
param budgetStartDate = '2026-11-01'
param createPostgres = false
param extensionOrigin = 'chrome-extension://REPLACE_WITH_EXTENSION_ID'
param apiMinReplicas = 0
param enableBackgroundCompute = false
// Secrets are passed on the command line, never stored in this file:
//   --parameters llmApiKey=$LLM_API_KEY databaseUrl=$NEON_DATABASE_URL
