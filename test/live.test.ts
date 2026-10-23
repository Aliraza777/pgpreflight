import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { discover } from "../src/discover.js";
import { Db, parseUrl, rateBySize, SIZE } from "../src/live.js";
import type { Finding, Project } from "../src/types.js";
import { createTestDb, HAS_PG, type TestDb, tempProject, write } from "./helpers.js";

const sqlProject = (sql: string): Project => ({
  tool: "sql",
  root: "/x",
  transaction: "none",
  migrations: [{ name: "m", file: "/x/m.sql", sql }],
});

describe("parseUrl", () => {
  it("moves Prisma's ?schema= into a search_path and drops Prisma-only params", () => {
    expect(
      parseUrl("postgresql://u@h:5432/db?schema=app&connection_limit=5&sslmode=require"),
    ).toEqual({
      connectionString: "postgresql://u@h:5432/db?sslmode=require",
      schema: "app",
    });
  });
});

describe("rateBySize", () => {
  const f = (): Finding => ({
    rule: "x",
    severity: "warn",
    title: "t",
    lock: "ACCESS EXCLUSIVE",
    rewrite: true,
  });
  it("escalates by rows and bytes, and calms small tables", () => {
    const big = f();
    rateBySize(big, { rows: SIZE.dangerRows, bytes: 0, exists: true });
    expect(big.severity).toBe("danger");
    const huge = f();
    rateBySize(huge, { rows: 10, bytes: SIZE.dangerBytes, exists: true });
    expect(huge.severity).toBe("danger");
    const small = f();
    rateBySize(small, { rows: 500, bytes: 8192, exists: true });
    expect(small.severity).toBe("info");
    const noLockImpact: Finding = {
      rule: "y",
      severity: "warn",
      title: "t",
      lock: "ACCESS EXCLUSIVE",
    };
    rateBySize(noLockImpact, { rows: SIZE.dangerRows, bytes: 0, exists: true });
    expect(noLockImpact.severity).toBe("warn");
  });
});

describe.skipIf(!HAS_PG)("against a real Postgres", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
    await db.exec(`
      CREATE TABLE "User" (id serial PRIMARY KEY, email text, name text, role text, "deletedAt" timestamptz, age text);
      INSERT INTO "User"(email, name, role, age, "deletedAt")
        SELECT CASE WHEN i % 100 = 0 THEN NULL WHEN i % 250 = 0 THEN 'Dup@x' ELSE 'u' || i END,
               'n' || i, CASE WHEN i % 40 = 0 THEN 'GUEST' ELSE 'USER' END,
               CASE WHEN i % 333 = 0 THEN 'unknown' ELSE (i % 90)::text END,
               CASE WHEN i % 500 = 0 THEN now() END
        FROM generate_series(1, 5000) i;
      INSERT INTO "User"(email, name, role, age) VALUES ('dup@x', 'case', 'USER', '1');
      CREATE TABLE "Order" (id serial PRIMARY KEY, "userId" int, total int);
      INSERT INTO "Order"("userId", total) SELECT (i % 5200) + 1, i % 7 - 1 FROM generate_series(1, 20000) i;
      CREATE TABLE empty_t (id int, v text);
      CREATE TABLE has_check (id int, c text);
      INSERT INTO has_check SELECT i, 'x' FROM generate_series(1, 10) i;
      ALTER TABLE has_check ADD CONSTRAINT c_nn CHECK (c IS NOT NULL);
      ANALYZE;
    `);
  });
  afterAll(() => db?.drop());

  const live = async (sql: string, opts = {}) => {
    const r = await check(sqlProject(sql), { databaseUrl: db.url, all: true, ...opts });
    return r.statements.flatMap((s) => s.findings);
  };
  const find = async (sql: string, rule: string, opts = {}) => {
    const f = (await live(sql, opts)).find((x) => x.rule === rule);
    expect(f, `expected ${rule}`).toBeDefined();
    return f as Finding;
  };

  it("connects read-only: writes are refused by the server", async () => {
    const conn = await Db.connect(db.url);
    await expect(conn.query("CREATE TABLE nope (a int)")).rejects.toThrow(/read-only/);
    await conn.close();
  });

  it("SET NOT NULL fails when NULLs exist; is a no-op or scan-free when already covered", async () => {
    const f = await find('ALTER TABLE "User" ALTER COLUMN email SET NOT NULL', "set-not-null");
    expect(f.severity).toBe("fail");
    expect(f.evidence?.join()).toContain("50 rows have NULL");
    expect(
      (
        await find('ALTER TABLE "User" ALTER COLUMN id SET NOT NULL', "set-not-null")
      ).evidence?.join(),
    ).toContain("already NOT NULL");
    const c = await find("ALTER TABLE has_check ALTER COLUMN c SET NOT NULL", "set-not-null");
    expect(c).toMatchObject({ severity: "info", scan: false });
  });

  it("ADD COLUMN NOT NULL without default: fails on rows, fine on an empty table", async () => {
    expect(
      (await find('ALTER TABLE "User" ADD COLUMN x text NOT NULL', "add-not-null-without-default"))
        .severity,
    ).toBe("fail");
    expect(
      (await find("ALTER TABLE empty_t ADD COLUMN x text NOT NULL", "add-not-null-without-default"))
        .severity,
    ).toBe("info");
  });

  it("finds duplicates, honoring expressions, partial indexes and NULLS NOT DISTINCT", async () => {
    const plain = await find('CREATE UNIQUE INDEX u ON "User" (email)', "unique-index-duplicates");
    expect(plain.severity).toBe("fail");
    expect(plain.evidence?.join()).toContain("1 duplicate value(s) across 10 rows");
    const lower = await find(
      'CREATE UNIQUE INDEX u ON "User" (lower(email))',
      "unique-index-duplicates",
    );
    expect(lower.evidence?.join()).toContain("across 11 rows");
    const partial = await find(
      'CREATE UNIQUE INDEX u ON "User" (email) WHERE "deletedAt" IS NOT NULL',
      "unique-index-duplicates",
    );
    expect(partial.severity).toBe("info");
    const nnd = await find(
      'CREATE UNIQUE INDEX u ON "User" (email) NULLS NOT DISTINCT',
      "unique-index-duplicates",
    );
    expect(nnd.evidence?.join()).toContain("2 duplicate value(s)");
    const withValues = await find(
      'CREATE UNIQUE INDEX u ON "User" (email)',
      "unique-index-duplicates",
      { showValues: true },
    );
    expect(withValues.evidence?.join()).toContain('"Dup@x"');
  });

  it("finds foreign-key orphans with explicit or implicit (primary key) references", async () => {
    const f = await find(
      'ALTER TABLE "Order" ADD CONSTRAINT f FOREIGN KEY ("userId") REFERENCES "User"(id)',
      "add-foreign-key",
    );
    expect(f.severity).toBe("fail");
    expect(f.evidence?.join()).toMatch(/\d[\d,]* rows in Order point to missing User rows/);
    const implicit = await find(
      'ALTER TABLE "Order" ADD CONSTRAINT f FOREIGN KEY ("userId") REFERENCES "User"',
      "add-foreign-key",
    );
    expect(implicit.severity).toBe("fail");
  });

  it("evaluates CHECK constraints and type conversions against real rows", async () => {
    const chk = await find(
      'ALTER TABLE "Order" ADD CONSTRAINT pos CHECK (total >= 0)',
      "add-check-constraint",
    );
    expect(chk.severity).toBe("fail");
    const okChk = await find(
      'ALTER TABLE "Order" ADD CONSTRAINT p2 CHECK (total >= -1)',
      "add-check-constraint",
    );
    expect(okChk.severity).not.toBe("fail");
    const cast = await find(
      'ALTER TABLE "User" ALTER COLUMN age TYPE integer',
      "change-column-type",
    );
    if (db.version >= 160000) {
      expect(cast.severity).toBe("fail");
      expect(cast.evidence?.join()).toContain("15 values in age can't be converted to integer");
    } else
      expect(cast.evidence?.join()).toContain("can't test value conversion before Postgres 16");
  });

  it("checks removed enum values when Prisma recreates an enum", async () => {
    const f = await find(
      `CREATE TYPE "Role_new" AS ENUM ('USER', 'ADMIN');
       ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");`,
      "change-column-type",
    );
    expect(f.severity).toBe("fail");
    expect(f.evidence?.join()).toContain(
      "125 rows use enum values that Role_new no longer has (GUEST)",
    );
  });

  it("measures data loss and confirms default volatility from pg_proc", async () => {
    const drop = await find('ALTER TABLE "User" DROP COLUMN name', "drop-column");
    expect(drop.evidence?.join()).toContain("deletes 5,001 non-null value(s) in name");
    const vol = await find(
      'ALTER TABLE "Order" ADD COLUMN p uuid DEFAULT gen_random_uuid()',
      "add-column-volatile-default",
    );
    expect(vol.rewrite).toBe(true);
    const stable = await find(
      'ALTER TABLE "Order" ADD COLUMN t timestamptz DEFAULT now()',
      "add-column-volatile-default",
    );
    expect(stable).toMatchObject({ rewrite: false, severity: "info" });
  });

  it("reports when a check exceeds the time limit instead of hanging", async () => {
    const f = await find(
      'ALTER TABLE "Order" ADD CONSTRAINT slow CHECK (pg_sleep(0.01) IS NOT NULL)',
      "add-check-constraint",
      { timeoutMs: 100 },
    );
    expect(f.evidence?.join()).toContain("could not verify within 0.1s");
  });

  it("detects schema drift: objects that already exist or are missing", async () => {
    const rules = async (sql: string) =>
      (await live(sql)).filter((f) => f.rule === "schema-drift").map((f) => f.title);
    expect(await rules('ALTER TABLE "User" ADD COLUMN email text')).toEqual([
      "Column User.email already exists, so ADD COLUMN will fail",
    ]);
    expect(await rules('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS email text')).toEqual([]);
    expect(await rules('ALTER TABLE "User" DROP COLUMN nope')).toEqual([
      "Column User.nope does not exist, so DROP COLUMN will fail",
    ]);
    expect(await rules('CREATE TABLE "User" (id int)')).toEqual([
      "Table User already exists, so CREATE TABLE will fail",
    ]);
    expect(await rules("ALTER TABLE ghost ADD COLUMN a int")).toEqual([
      "Table ghost does not exist, so ALTER TABLE will fail",
    ]);
    expect(await rules('CREATE INDEX "User_pkey" ON "User" (email)')).toEqual([
      'Index "User_pkey" already exists, so CREATE INDEX will fail',
    ]);
    expect(await rules('ALTER TABLE "User" RENAME COLUMN name TO email')).toEqual([
      "Column User.email already exists, so RENAME COLUMN will fail",
    ]);
    // Statements see the effect of earlier ones in the same run.
    expect(
      await rules(
        "CREATE TABLE brand_new (a int); ALTER TABLE brand_new ADD COLUMN b int; ALTER TABLE brand_new DROP COLUMN a;",
      ),
    ).toEqual([]);
  });

  it("warns about long transactions holding locks on affected tables", async () => {
    const blocker = new pg.Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query('SELECT count(*) FROM "Order"');
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await check(sqlProject('ALTER TABLE "Order" ALTER COLUMN total SET NOT NULL'), {
        databaseUrl: db.url,
        all: true,
        blockingSeconds: 1,
      });
      const note = r.notes.find((n) => n.rule === "blocking-transaction");
      expect(note?.title).toMatch(/held locks on Order for \d+ s \(idle in transaction\)/);
      expect(r.db?.blocking[0]?.tables).toContain("Order");
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });

  it("selects only pending Prisma migrations from _prisma_migrations", async () => {
    await db.exec(`CREATE TABLE _prisma_migrations (id text PRIMARY KEY, migration_name text NOT NULL, finished_at timestamptz, rolled_back_at timestamptz);
      INSERT INTO _prisma_migrations VALUES ('1', '20261023105019_init', now(), NULL), ('2', '20261023120000_daily_changes', NULL, now());`);
    const project = discover(tempProject("prisma-app"));
    const r = await check(project, { databaseUrl: db.url });
    expect(r.checked.map((m) => m.name)).toEqual(["20261023120000_daily_changes"]);
    expect(r.checked[0]?.pending).toBe(true);
    await db.exec("DROP TABLE _prisma_migrations");
  });

  it("selects pending Drizzle migrations by journal timestamp, in the configured table", async () => {
    const root = tempProject("drizzle-app");
    const project = discover(root);
    const first = project.migrations[0]?.when;
    await db.exec(
      `CREATE TABLE public.my_migrations (id serial, hash text, created_at bigint); INSERT INTO public.my_migrations (hash, created_at) VALUES ('h', ${first});`,
    );
    const r = await check(project, { databaseUrl: db.url });
    expect(r.checked.map((m) => m.name)).toEqual(["0001_v2", "0002_concurrent_idx"]);
    expect(r.notes.map((n) => n.rule)).toContain("drizzle-single-transaction");
    await db.exec("DROP TABLE public.my_migrations");
  });

  it("treats every migration as pending when the tool's table doesn't exist yet", async () => {
    const root = tempProject();
    write(root, "prisma/migrations/migration_lock.toml", 'provider = "postgresql"');
    write(root, "prisma/migrations/1_a/migration.sql", "CREATE TABLE a (id int);");
    write(root, "prisma/migrations/2_b/migration.sql", "ALTER TABLE a ADD COLUMN b int;");
    const r = await check(discover(root), { databaseUrl: db.url });
    expect(r.checked.map((m) => m.name)).toEqual(["1_a", "2_b"]);
  });
});
