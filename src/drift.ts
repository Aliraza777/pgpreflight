import type { Db } from "./live.js";
import {
  displayTable,
  type Node,
  names,
  quoteTable,
  type Statement,
  tableKey,
  tableRef,
} from "./sql.js";
import type { Finding, TableRef } from "./types.js";

/**
 * Replays the pending statements against the real catalog and reports the ones that will fail
 * because the schema isn't what the migration expects: "already exists", "does not exist".
 * This catches migrations that were partly applied by hand or a half-failed deploy.
 */
export class DriftChecker {
  private relations = new Map<string, boolean>();
  private columns = new Map<string, Set<string>>();
  private types = new Map<string, boolean>();
  /** Index name → whether it exists; index names are schema-wide. */
  private indexes = new Map<string, boolean>();

  constructor(private db: Db) {}

  private async relationExists(t: TableRef): Promise<boolean> {
    const k = tableKey(t);
    if (!this.relations.has(k)) {
      const [r] = await this.db.query<{ r: string | null }>("SELECT to_regclass($1)::text r", [
        quoteTable(t),
      ]);
      this.relations.set(k, !!r?.r);
    }
    return this.relations.get(k) as boolean;
  }

  private async columnSet(t: TableRef): Promise<Set<string>> {
    const k = tableKey(t);
    if (!this.columns.has(k)) {
      const rows = (await this.relationExists(t))
        ? await this.db.query<{ a: string }>(
            "SELECT attname a FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped",
            [quoteTable(t)],
          )
        : [];
      this.columns.set(k, new Set(rows.map((r) => r.a)));
    }
    return this.columns.get(k) as Set<string>;
  }

  private async indexExists(name: string, schema?: string): Promise<boolean> {
    const k = `${schema ?? "public"}.${name}`;
    if (!this.indexes.has(k)) this.indexes.set(k, await this.relationExists({ schema, name }));
    return this.indexes.get(k) as boolean;
  }

  private async typeExists(name: string): Promise<boolean> {
    if (!this.types.has(name)) {
      const [r] = await this.db.query<{ r: string | null }>("SELECT to_regtype($1)::text r", [
        `"${name.replace(/"/g, '""')}"`,
      ]);
      this.types.set(name, !!r?.r);
    }
    return this.types.get(name) as boolean;
  }

  private fail(title: string, table?: TableRef): Finding {
    return {
      rule: "schema-drift",
      severity: "fail",
      title,
      table,
      detail:
        "The database doesn't match what this migration expects. Was part of it applied by hand, or did an earlier deploy fail halfway?",
      fix: "Compare the live schema with the migration. For Prisma, `prisma migrate diff` and `prisma migrate resolve` help reconcile.",
    };
  }

  /** Check one statement, then apply its effect so later statements see the new schema. */
  async check(stmt: Statement): Promise<Finding[]> {
    const n: Node = stmt.node;
    const out: Finding[] = [];
    switch (stmt.kind) {
      case "CreateStmt": {
        const t = tableRef(n.relation);
        if (!n.if_not_exists && (await this.relationExists(t)))
          out.push(
            this.fail(`Table ${displayTable(t)} already exists, so CREATE TABLE will fail`, t),
          );
        this.relations.set(tableKey(t), true);
        const cols = new Set<string>();
        for (const e of n.tableElts ?? []) if (e.ColumnDef?.colname) cols.add(e.ColumnDef.colname);
        this.columns.set(tableKey(t), cols);
        break;
      }
      case "IndexStmt": {
        const t = tableRef(n.relation);
        if (!(await this.relationExists(t)))
          out.push(
            this.fail(`Table ${displayTable(t)} does not exist, so CREATE INDEX will fail`, t),
          );
        if (n.idxname && !n.if_not_exists && (await this.indexExists(n.idxname, t.schema)))
          out.push(this.fail(`Index "${n.idxname}" already exists, so CREATE INDEX will fail`, t));
        if (n.idxname) this.indexes.set(`${t.schema ?? "public"}.${n.idxname}`, true);
        break;
      }
      case "CreateEnumStmt": {
        const name = names(n.typeName).pop() ?? "";
        if (await this.typeExists(name))
          out.push(this.fail(`Type "${name}" already exists, so CREATE TYPE will fail`));
        this.types.set(name, true);
        break;
      }
      case "AlterTableStmt": {
        if (n.objtype && n.objtype !== "OBJECT_TABLE") break;
        const t = tableRef(n.relation);
        if (!(await this.relationExists(t))) {
          if (!n.missing_ok)
            out.push(
              this.fail(`Table ${displayTable(t)} does not exist, so ALTER TABLE will fail`, t),
            );
          break;
        }
        const cols = await this.columnSet(t);
        for (const c of n.cmds ?? []) {
          const cmd = c.AlterTableCmd;
          if (!cmd) continue;
          if (cmd.subtype === "AT_AddColumn") {
            const name = cmd.def?.ColumnDef?.colname;
            if (name && cols.has(name) && !cmd.missing_ok)
              out.push(
                this.fail(
                  `Column ${displayTable(t)}.${name} already exists, so ADD COLUMN will fail`,
                  t,
                ),
              );
            if (name) cols.add(name);
          } else if (cmd.subtype === "AT_DropColumn") {
            if (!cols.has(cmd.name) && !cmd.missing_ok)
              out.push(
                this.fail(
                  `Column ${displayTable(t)}.${cmd.name} does not exist, so DROP COLUMN will fail`,
                  t,
                ),
              );
            cols.delete(cmd.name);
          } else if (
            [
              "AT_SetNotNull",
              "AT_DropNotNull",
              "AT_AlterColumnType",
              "AT_ColumnDefault",
              "AT_SetStatistics",
            ].includes(cmd.subtype) &&
            cmd.name &&
            !cols.has(cmd.name)
          ) {
            out.push(
              this.fail(
                `Column ${displayTable(t)}.${cmd.name} does not exist, so ALTER COLUMN will fail`,
                t,
              ),
            );
          }
        }
        break;
      }
      case "RenameStmt": {
        if (n.renameType === "OBJECT_COLUMN") {
          const t = tableRef(n.relation);
          const cols = await this.columnSet(t);
          if (!cols.has(n.subname) && !n.missing_ok)
            out.push(
              this.fail(
                `Column ${displayTable(t)}.${n.subname} does not exist, so RENAME COLUMN will fail`,
                t,
              ),
            );
          else if (cols.has(n.newname))
            out.push(
              this.fail(
                `Column ${displayTable(t)}.${n.newname} already exists, so RENAME COLUMN will fail`,
                t,
              ),
            );
          cols.delete(n.subname);
          cols.add(n.newname);
        } else if (n.renameType === "OBJECT_TABLE") {
          const t = tableRef(n.relation);
          const to = { schema: t.schema, name: n.newname };
          if (!(await this.relationExists(t)) && !n.missing_ok)
            out.push(this.fail(`Table ${displayTable(t)} does not exist, so RENAME will fail`, t));
          else if (await this.relationExists(to))
            out.push(this.fail(`Table ${displayTable(to)} already exists, so RENAME will fail`, t));
          this.columns.set(tableKey(to), await this.columnSet(t));
          this.relations.set(tableKey(t), false);
          this.relations.set(tableKey(to), true);
        }
        break;
      }
      case "DropStmt": {
        if (n.removeType !== "OBJECT_TABLE" && n.removeType !== "OBJECT_INDEX") break;
        for (const o of n.objects ?? []) {
          const parts = names(o?.List?.items);
          const t: TableRef =
            parts.length > 1
              ? { schema: parts[0], name: parts[1] ?? "" }
              : { name: parts[0] ?? "" };
          if (!(await this.relationExists(t)) && !n.missing_ok)
            out.push(
              this.fail(
                `${n.removeType === "OBJECT_TABLE" ? "Table" : "Index"} ${displayTable(t)} does not exist, so DROP will fail`,
                t,
              ),
            );
          this.relations.set(tableKey(t), false);
        }
        break;
      }
    }
    return out;
  }
}
