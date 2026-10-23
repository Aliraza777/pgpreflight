import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

/** Admin connection for integration tests: $PGPREFLIGHT_TEST_URL or the local dev server. */
export const ADMIN_URL =
  process.env.PGPREFLIGHT_TEST_URL ?? "postgres://postgres@localhost:54329/postgres";

async function reachable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2_000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

export const HAS_PG = await reachable();
if (!HAS_PG && process.env.PGPREFLIGHT_TEST_URL) throw new Error(`No Postgres at ${ADMIN_URL}`);

export interface TestDb {
  url: string;
  /** server_version_num, e.g. 170007 */
  version: number;
  /** Run SQL as the owner (not read-only). */
  exec: (sql: string) => Promise<pg.QueryResult>;
  drop: () => Promise<void>;
}

/** A fresh database that tests can fill and then throw away. */
export async function createTestDb(): Promise<TestDb> {
  const name = `pgpreflight_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const version = Number(
    (await client.query("SHOW server_version_num")).rows[0].server_version_num,
  );
  return {
    url,
    version,
    exec: (sql) => client.query(sql),
    drop: async () => {
      await client.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Empty temp dir, or a writable copy of a fixture project. */
export function tempProject(fixture?: string): string {
  const root = mkdtempSync(join(tmpdir(), "pgpreflight-"));
  if (fixture) cpSync(join(FIXTURES, fixture), root, { recursive: true });
  return root;
}

export function write(root: string, path: string, content: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
