// DEPRECATED — this was a one-time Supabase seeder. The catalogue has since
// been migrated to Azure SQL (see azure_schema.sql + the migration in this
// folder), so re-seeding would create duplicates. Kept as a stub to document
// that history and to fail loudly instead of running against a dead backend.
//
// To inspect current data use: tsx scripts/inspect_db.ts
console.error(
  'seed_data.ts is deprecated. The database now lives in Azure SQL and is already seeded.\n' +
    'Re-running a seeder would duplicate rows. If you genuinely need to reseed, write a new\n' +
    'Azure-targeted script using src/db.ts.'
)
process.exit(1)
