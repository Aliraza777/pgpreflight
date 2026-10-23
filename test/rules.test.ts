import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import type { Finding, Project, Tool } from "../src/types.js";

const TX: Record<Tool, Project["transaction"]> = {
  prisma: "per-file-if-multiple",
  drizzle: "all-pending",
  sql: "none",
};

/** Run static checks on migrations (each string is one migration file). */
async function findings(sqls: string | string[], tool: Tool = "sql"): Promise<Finding[]> {
  const list = Array.isArray(sqls) ? sqls : [sqls];
  const project: Project = {
    tool,
    root: "/x",
    transaction: TX[tool],
    migrations: list.map((sql, i) => ({ name: `m${i}`, file: `/x/m${i}.sql`, sql })),
  };
  const r = await check(project, { all: true });
  return r.statements.flatMap((s) => s.findings);
}
const rules = async (sql: string | string[], tool: Tool = "sql") =>
  (await findings(sql, tool)).map((f) => f.rule);
const one = async (sql: string, rule: string, tool: Tool = "sql") => {
  const f = (await findings(sql, tool)).find((x) => x.rule === rule);
  expect(f, `expected ${rule}`).toBeDefined();
  return f as Finding;
};

describe("ADD COLUMN", () => {
  it("NOT NULL without default is dangerous; with a default it is not", async () => {
    expect(
      (await one('ALTER TABLE "User" ADD COLUMN "c" text NOT NULL', "add-not-null-without-default"))
        .severity,
    ).toBe("danger");
    expect(await rules(`ALTER TABLE "User" ADD COLUMN "c" text NOT NULL DEFAULT 'x'`)).toEqual([]);
  });

  it("volatile defaults rewrite, stable ones are only informational", async () => {
    const v = await one(
      "ALTER TABLE o ADD COLUMN id2 uuid DEFAULT gen_random_uuid()",
      "add-column-volatile-default",
    );
    expect(v).toMatchObject({ severity: "warn", rewrite: true, lock: "ACCESS EXCLUSIVE" });
    const s = await one(
      "ALTER TABLE o ADD COLUMN t timestamptz DEFAULT now()",
      "add-column-volatile-default",
    );
    expect(s).toMatchObject({ severity: "info", rewrite: false });
    expect(await rules("ALTER TABLE o ADD COLUMN t timestamptz DEFAULT CURRENT_TIMESTAMP")).toEqual(
      [],
    );
  });

  it("identity, serial and stored generated columns rewrite the table", async () => {
    for (const def of [
      "bigserial",
      "int GENERATED ALWAYS AS IDENTITY",
      "int GENERATED ALWAYS AS (a * 2) STORED",
    ])
      expect(await rules(`ALTER TABLE o ADD COLUMN n ${def}`)).toContain("add-column-rewrite");
  });
});

describe("constraints", () => {
  it("SET NOT NULL scans; adding then SET NOT NULL without default is dangerous", async () => {
    expect(await one("ALTER TABLE u ALTER COLUMN e SET NOT NULL", "set-not-null")).toMatchObject({
      scan: true,
      severity: "warn",
    });
    const f = await findings(
      "ALTER TABLE u ADD COLUMN e text; ALTER TABLE u ALTER COLUMN e SET NOT NULL;",
    );
    expect(f.find((x) => x.rule === "set-not-null")?.severity).toBe("danger");
  });

  it("FK and CHECK without NOT VALID scan; with NOT VALID they are skipped", async () => {
    expect(
      await rules("ALTER TABLE o ADD CONSTRAINT f FOREIGN KEY (u) REFERENCES u(id)"),
    ).toContain("add-foreign-key");
    expect(
      await rules("ALTER TABLE o ADD CONSTRAINT f FOREIGN KEY (u) REFERENCES u(id) NOT VALID"),
    ).toEqual([]);
    const chk = await one(
      "ALTER TABLE o ADD CONSTRAINT c CHECK (total >= 0)",
      "add-check-constraint",
    );
    expect(chk.live).toMatchObject({ kind: "checkViolations", expr: "total >= 0" });
    expect(await rules("ALTER TABLE o ADD CONSTRAINT c CHECK (total >= 0) NOT VALID")).toEqual([]);
  });

  it("UNIQUE/PRIMARY KEY build an index unless USING INDEX", async () => {
    expect(await rules("ALTER TABLE o ADD CONSTRAINT k UNIQUE (a, b)")).toContain(
      "add-unique-constraint",
    );
    expect(await rules("ALTER TABLE o ADD CONSTRAINT k PRIMARY KEY USING INDEX i")).toEqual([]);
  });
});

describe("indexes", () => {
  it("non-concurrent CREATE INDEX blocks writes; unique indexes get a duplicate check", async () => {
    const f = await findings(
      'CREATE UNIQUE INDEX "u" ON "User" (lower("email")) WHERE "deletedAt" IS NULL',
    );
    expect(f.map((x) => x.rule)).toEqual(["create-index-blocking", "unique-index-duplicates"]);
    expect(f[1]?.live).toMatchObject({ exprs: ["(lower(email))"], where: '"deletedAt" IS NULL' });
  });

  it("CONCURRENTLY fails inside Prisma multi-statement files and in every Drizzle migration", async () => {
    const conc = "CREATE INDEX CONCURRENTLY i ON t (a)";
    expect(await rules(conc, "prisma")).toEqual([]);
    expect(await rules(`SELECT 1; ${conc};`, "prisma")).toContain("concurrently-in-transaction");
    expect(await rules(conc, "drizzle")).toContain("concurrently-in-transaction");
    expect(await rules(conc, "sql")).toEqual([]);
    expect(await rules(`BEGIN; ${conc}; COMMIT;`, "sql")).toContain("concurrently-in-transaction");
  });
});

describe("tables created in the same batch are empty", () => {
  it("skips size and data rules for brand-new tables, across migrations", async () => {
    expect(
      await rules([
        "CREATE TABLE fresh (id int, e text)",
        "ALTER TABLE fresh ADD COLUMN c text NOT NULL; CREATE UNIQUE INDEX ON fresh (e); ALTER TABLE fresh ALTER COLUMN e SET NOT NULL;",
      ]),
    ).toEqual([]);
  });

  it("still fails CONCURRENTLY on a new table inside a transaction", async () => {
    expect(
      await rules("CREATE TABLE n (a int); CREATE INDEX CONCURRENTLY ON n (a);", "drizzle"),
    ).toEqual(["concurrently-in-transaction"]);
  });
});

describe("data loss and compatibility", () => {
  it("detects a rename done as DROP + ADD and pairs the most similar name", async () => {
    const f = await findings(
      'ALTER TABLE "User" DROP COLUMN "fullName", ADD COLUMN "country" TEXT, ADD COLUMN "name" TEXT',
    );
    const r = f.filter((x) => x.rule === "rename-as-drop-add");
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toContain("fullName → name (or country)");
    expect(r[0]?.fix).toContain('RENAME COLUMN "fullName" TO "name"');
    expect(f.map((x) => x.rule)).not.toContain("drop-column");
  });

  it("flags drops, renames, truncates and unbounded data changes", async () => {
    expect(await rules("ALTER TABLE t DROP COLUMN c")).toEqual(["drop-column"]);
    expect(await rules("DROP TABLE t")).toEqual(["drop-table"]);
    expect(await rules("ALTER TABLE t RENAME COLUMN a TO b")).toEqual(["rename-column"]);
    expect(await rules("ALTER TABLE t RENAME TO t2")).toEqual(["rename-table"]);
    expect(await rules("TRUNCATE t")).toEqual(["truncate"]);
    expect(await rules("DELETE FROM t")).toEqual(["data-migration"]);
    expect(await rules("UPDATE t SET a = 1 WHERE id < 10")).toEqual(["data-migration"]);
  });

  it("type changes rewrite unless widening to text/varchar; enum recreation checks values", async () => {
    expect(
      await one("ALTER TABLE t ALTER COLUMN a TYPE bigint", "change-column-type"),
    ).toMatchObject({ rewrite: true, severity: "warn" });
    expect(await one("ALTER TABLE t ALTER COLUMN a TYPE text", "change-column-type")).toMatchObject(
      { rewrite: false, severity: "info" },
    );
    const f = await one(
      `CREATE TYPE "Role_new" AS ENUM ('USER', 'ADMIN'); ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");`,
      "change-column-type",
    );
    expect(f.live).toMatchObject({
      kind: "enumValues",
      allowed: ["USER", "ADMIN"],
      enumName: "Role_new",
    });
  });

  it("ignores safe statements", async () => {
    expect(
      await rules(
        "CREATE TABLE a (id int); ALTER TABLE t ALTER COLUMN c DROP NOT NULL; CREATE INDEX CONCURRENTLY i ON t (c); SELECT 1;",
      ),
    ).toEqual([]);
  });
});

describe("whole-run notes", () => {
  it("asks for lock_timeout unless the migration sets it", async () => {
    const project = (sql: string): Project => ({
      tool: "sql",
      root: "/x",
      transaction: "none",
      migrations: [{ name: "m", file: "/x/m.sql", sql }],
    });
    const r1 = await check(project("ALTER TABLE t ALTER COLUMN c SET NOT NULL"), { all: true });
    expect(r1.notes.map((n) => n.rule)).toContain("missing-lock-timeout");
    const r2 = await check(
      project("SET lock_timeout = '5s'; ALTER TABLE t ALTER COLUMN c SET NOT NULL;"),
      { all: true },
    );
    expect(r2.notes.map((n) => n.rule)).not.toContain("missing-lock-timeout");
  });

  it("reports unparseable migrations as failing", async () => {
    expect(await rules("ALTER TABL x")).toEqual(["syntax-error"]);
  });
});
