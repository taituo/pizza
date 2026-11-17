import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadConfig } from './config';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const LOCK_KEY = 728_193_501;

export async function migrate(databaseUrl: string, log: (msg: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Advisory lock: several pods starting at once do not run migrations on top of each other.
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const applied = new Set(
      (await client.query('select name from schema_migrations')).rows.map((r) => r.name as string),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    log('[migrate] schema is up to date');
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  migrate(loadConfig().databaseUrl).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
