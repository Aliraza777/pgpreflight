import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "../src/discover.js";
import { tempProject, write } from "./helpers.js";

describe("discover", () => {
  it("finds real Prisma 7 migrations in order", () => {
    const root = tempProject("prisma-app");
    const p = discover(root);
    expect(p.tool).toBe("prisma");
    expect(p.transaction).toBe("per-file-if-multiple");
    expect(p.migrations.map((m) => m.name)).toEqual([
      "20261023105019_init",
      "20261023120000_daily_changes",
    ]);
    expect(p.migrations[1]?.sql).toContain('DROP COLUMN "fullName"');
  });

  it("follows package.json prisma.schema to a custom folder", () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ prisma: { schema: "db/schema.prisma" } }));
    write(root, "db/migrations/migration_lock.toml", 'provider = "postgresql"');
    write(root, "db/migrations/001_a/migration.sql", "SELECT 1;");
    expect(discover(root).migrations.map((m) => m.name)).toEqual(["001_a"]);
  });

  it("reads a real Drizzle config: custom out dir, migrations table and journal order", () => {
    const root = tempProject("drizzle-app");
    const p = discover(root);
    expect(p.tool).toBe("drizzle");
    expect(p.transaction).toBe("all-pending");
    expect(p.drizzleMigrationsTable).toEqual({ schema: "public", table: "my_migrations" });
    expect(p.migrations.map((m) => m.name)).toEqual([
      "0000_init",
      "0001_v2",
      "0002_concurrent_idx",
    ]);
    expect(p.migrations.every((m) => typeof m.when === "number" && m.when > 0)).toBe(true);
  });

  it("defaults Drizzle to ./drizzle and drizzle.__drizzle_migrations", () => {
    const root = tempProject();
    write(root, "drizzle.config.ts", "export default { dialect: 'postgresql' }");
    write(
      root,
      "drizzle/meta/_journal.json",
      JSON.stringify({ entries: [{ idx: 0, when: 5, tag: "0000_x" }] }),
    );
    write(root, "drizzle/0000_x.sql", "SELECT 1;");
    const p = discover(root);
    expect(p.drizzleMigrationsTable).toEqual({ schema: "drizzle", table: "__drizzle_migrations" });
    expect(p.migrations.map((m) => m.name)).toEqual(["0000_x"]);
  });

  it("accepts explicit .sql files and directories", () => {
    const root = tempProject();
    write(root, "sql/002_b.sql", "SELECT 2;");
    write(root, "sql/001_a.sql", "SELECT 1;");
    write(root, "one.sql", "SELECT 3;");
    expect(discover(root, ["sql"]).migrations.map((m) => m.name)).toEqual([
      "001_a.sql",
      "002_b.sql",
    ]);
    expect(discover(root, ["one.sql"])).toMatchObject({ tool: "sql", transaction: "none" });
    expect(() => discover(root, ["missing.sql"])).toThrow(/No such file/);
  });

  it("keeps Prisma semantics for an explicit Prisma migration path", () => {
    const root = tempProject("prisma-app");
    const p = discover(root, [join("prisma", "migrations", "20261023120000_daily_changes")]);
    expect(p.tool).toBe("prisma");
    expect(p.migrations.map((m) => m.name)).toEqual(["20261023120000_daily_changes"]);
  });

  it("explains when nothing is found", () => {
    expect(() => discover(tempProject())).toThrow(/No migrations found/);
  });
});
