import { config } from 'dotenv';
import { createDatabase } from './client.js';
import { migrateDatabase } from './migrations.js';

config({ path: new URL('../../../.env', import.meta.url), quiet: true });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required. Copy .env.example to .env.');
  process.exitCode = 1;
} else {
  const database = createDatabase(url);
  try {
    await migrateDatabase(database.db);
    console.info('Solemn database migrations applied');
  } catch {
    console.error(
      'Solemn migration failed. Check database connectivity and migration permissions.',
    );
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
