import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

export async function migrateDatabase(db: Database): Promise<void> {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
  });
}
