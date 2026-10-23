import { describe, expect, it } from "vitest";
import {
  calledFunctions,
  exprToSql,
  parseStatements,
  SqlParseError,
  tableKey,
  typeName,
} from "../src/sql.js";

describe("parseStatements", () => {
  it("splits statements with exact line numbers, skipping comments", async () => {
    const sql =
      "/* header\n comment */\n-- AlterTable\nALTER TABLE a ADD COLUMN b int;\n\n\nCREATE INDEX i ON a (b);";
    const s = await parseStatements(sql);
    expect(s.map((x) => [x.kind, x.line, x.text])).toEqual([
      ["AlterTableStmt", 4, "ALTER TABLE a ADD COLUMN b int"],
      ["IndexStmt", 7, "CREATE INDEX i ON a (b)"],
    ]);
  });

  it("handles Drizzle statement-breakpoint comments", async () => {
    const s = await parseStatements(
      'ALTER TABLE "a" ADD COLUMN "b" int;--> statement-breakpoint\nCREATE INDEX "i" ON "a" ("b");',
    );
    expect(s.map((x) => x.kind)).toEqual(["AlterTableStmt", "IndexStmt"]);
  });

  it("reports the line of a syntax error", async () => {
    await expect(parseStatements("SELECT 1;\n\nALTER TABL x;")).rejects.toMatchObject({ line: 3 });
    await expect(parseStatements("ALTER TABL x")).rejects.toBeInstanceOf(SqlParseError);
  });

  it("returns nothing for comment-only files", async () => {
    expect(await parseStatements("-- nothing here\n")).toEqual([]);
  });
});

describe("AST helpers", () => {
  it("names types, functions and tables", async () => {
    const [s] = await parseStatements(
      "ALTER TABLE x.y ADD COLUMN c varchar(20)[] DEFAULT md5(random()::text)",
    );
    const col = s!.node.cmds[0].AlterTableCmd.def.ColumnDef;
    expect(typeName(col.typeName)).toBe("varchar(20)[]");
    const def = col.constraints.find(
      (c: { Constraint: { contype: string } }) => c.Constraint.contype === "CONSTR_DEFAULT",
    );
    expect([...calledFunctions(def.Constraint.raw_expr)].sort()).toEqual(["md5", "random"]);
    expect(tableKey({ name: "t" })).toBe("public.t");
    expect(await exprToSql(def.Constraint.raw_expr)).toBe("md5((random())::text)");
  });
});
