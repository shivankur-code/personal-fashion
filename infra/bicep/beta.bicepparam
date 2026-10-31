using 'main.bicep'

param env = 'beta'
param ownerEmail = 'harshvardhanguptaus@gmail.com'
param monthlyBudget = 250
// First day of the month of the first deployment. Set once; never change it afterwards.
param budgetStartDate = '2026-11-01'
param createPostgres = true
param extensionOrigin = 'chrome-extension://REPLACE_WITH_EXTENSION_ID'
param apiMinReplicas = 1
// Passed on the command line: pgAdminPassword, anthropicApiKey, databaseUrl
