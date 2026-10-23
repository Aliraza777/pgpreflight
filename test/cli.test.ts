import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, HAS_PG, type TestDb, tempProject, write } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

function cli(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: undefined, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const sqlDir = (sql: string) => {
  const root = tempProject();
  write(root, "m.sql", sql);
  return root;
};

describe("cli (static)", () => {
  it("prints the version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(cli(tempProject(), ["--version"]).out.trim()).toBe(pkg.version);
  });

  it("exits 1 on dangerous findings and 0 when safe", () => {
    const bad = cli(sqlDir("DROP TABLE users;"), ["m.sql"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("DROP TABLE users deletes all its data");
    expect(bad.out).toContain("Static checks only");
    const ok = cli(sqlDir("CREATE TABLE a (id int);"), ["m.sql"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("Looks safe");
  });

  it("respects --fail-on", () => {
    const root = sqlDir("ALTER TABLE t ALTER COLUMN c SET NOT NULL;");
    expect(cli(root, ["m.sql"]).code).toBe(0);
    expect(cli(root, ["m.sql", "--fail-on", "warn"]).code).toBe(1);
    expect(cli(sqlDir("DROP TABLE t;"), ["m.sql", "--fail-on", "never"]).code).toBe(0);
  });

  it("checks the newest Prisma migration without a database, and all with --all", () => {
    const root = tempProject("prisma-app");
    const last = cli(root, []);
    expect(last.out).toContain("prisma · 1 migration");
    expect(last.out).toContain("20261023120000_daily_changes");
    expect(cli(root, ["--all"]).out).toContain("prisma · 2 migrations");
  });

  it("flags the CONCURRENTLY migration in the real Drizzle fixture", () => {
    const r = cli(tempProject("drizzle-app"), ["--last", "3"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("CREATE INDEX CONCURRENTLY cannot run inside a transaction block");
  });

  it("writes JSON and Markdown", () => {
    const root = sqlDir("DROP TABLE t;");
    const json = JSON.parse(cli(root, ["m.sql", "-f", "json"]).out);
    expect(json.summary).toEqual({ fail: 0, danger: 1, warn: 1, info: 0 });
    expect(json.statements[0].findings[0].rule).toBe("drop-table");
    const md = cli(root, ["m.sql", "-f", "md"]).out;
    expect(md).toContain("### ⚠️ pgpreflight: 1 migration checked");
    expect(md).toContain("```sql");
  });

  it("explains missing migrations and bad connections with exit code 2", () => {
    const none = cli(tempProject(), []);
    expect(none.code).toBe(2);
    expect(none.err).toContain("No migrations found");
    const bad = cli(sqlDir("SELECT 1;"), ["m.sql", "--db", "postgres://nobody@127.0.0.1:1/x"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Could not connect to the database");
  });
});

describe.skipIf(!HAS_PG)("cli (live)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
    await db.exec(
      "CREATE TABLE users (id int, email text); INSERT INTO users VALUES (1, NULL), (2, 'a'), (3, 'a');",
    );
  });
  afterAll(() => db?.drop());

  it("uses DATABASE_URL and reports what will fail", () => {
    const root = sqlDir(
      "ALTER TABLE users ALTER COLUMN email SET NOT NULL;\nCREATE UNIQUE INDEX ON users (email);",
    );
    const r = cli(root, ["m.sql"], { DATABASE_URL: db.url });
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 rows have NULL in email, so SET NOT NULL WILL FAIL");
    expect(r.out).toContain("1 duplicate value(s) across 2 rows");
    expect(r.out).toContain("✖ 2 will fail");
  });

  it("--no-db ignores DATABASE_URL", () => {
    const r = cli(
      sqlDir("ALTER TABLE users ALTER COLUMN email SET NOT NULL;"),
      ["m.sql", "--no-db"],
      { DATABASE_URL: db.url },
    );
    expect(r.out).toContain("no database (static checks only)");
  });
});
