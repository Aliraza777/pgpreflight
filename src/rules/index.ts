import {
  calledFunctions,
  displayTable,
  exprToSql,
  type Node,
  names,
  quoteIdent,
  quoteTable,
  type Statement,
  tableKey,
  tableRef,
  typeName,
} from "../sql.js";
import type { Finding, Project, TableRef } from "../types.js";

/** Facts accumulated while walking the pending migrations in order. */
export interface BatchState {
  createdTables: Set<string>;
  /** table key → column → whether it was added with a default */
  addedColumns: Map<string, Map<string, { hasDefault: boolean }>>;
  /** enum name → labels, for enums created in this batch */
  createdEnums: Map<string, string[]>;
  /** Statements are running inside a transaction (decides CONCURRENTLY failures). */
  inTransaction: boolean;
  setsLockTimeout: boolean;
  /** Columns dropped per table in the current migration, for rename detection. */
  droppedInMigration: Map<string, string[]>;
}

export function newBatchState(): BatchState {
  return {
    createdTables: new Set(),
    addedColumns: new Map(),
    createdEnums: new Map(),
    inTransaction: false,
    setsLockTimeout: false,
    droppedInMigration: new Map(),
  };
}

/** Functions whose result differs per row, so a DEFAULT using them rewrites the table. */
export const VOLATILE_FUNCTIONS = new Set([
  "random",
  "gen_random_uuid",
  "uuid_generate_v4",
  "uuid_generate_v1",
  "uuid_generate_v1mc",
  "uuidv4",
  "uuidv7",
  "clock_timestamp",
  "timeofday",
  "nextval",
  "txid_current",
]);

const SAFE_TYPE_CHANGE: Array<(from: string | undefined, to: string) => boolean> = [
  // varchar(n) → text or a longer varchar, numeric widening: binary-compatible, no rewrite.
  (_from, to) => to === "text",
  (_from, to) => /^varchar$/.test(to),
];

const isNew = (s: BatchState, t: TableRef) => s.createdTables.has(tableKey(t));

const CONCURRENTLY_FIX = {
  prisma:
    "Put the CREATE INDEX CONCURRENTLY statement alone in its own migration file: Prisma only wraps files with more than one statement in a transaction.",
  drizzle:
    "drizzle-kit migrate runs every pending migration inside one transaction, so CONCURRENTLY can never work there. Run this statement separately (e.g. psql) before deploying, and keep a plain CREATE INDEX IF NOT EXISTS in the migration.",
  sql: "Run it outside a transaction block.",
};

/** Analyze one statement. Mutates `state` with facts later statements depend on. */
export async function analyze(
  stmt: Statement,
  state: BatchState,
  project: Pick<Project, "tool">,
): Promise<Finding[]> {
  const n = stmt.node;
  switch (stmt.kind) {
    case "CreateStmt": {
      const t = tableRef(n.relation);
      state.createdTables.add(tableKey(t));
      return [];
    }
    case "CreateEnumStmt": {
      const name = names(n.typeName).pop() ?? "";
      state.createdEnums.set(name, names(n.vals));
      return [];
    }
    case "VariableSetStmt": {
      if (n.name === "lock_timeout") state.setsLockTimeout = true;
      return [];
    }
    case "TransactionStmt":
      return [];
    case "AlterTableStmt":
      if (n.objtype && n.objtype !== "OBJECT_TABLE") return [];
      return alterTable(n, state);
    case "IndexStmt":
      return createIndex(n, state, project.tool);
    case "DropStmt":
      return drop(n, state);
    case "RenameStmt":
      return rename(n, state);
    case "TruncateStmt":
      return (n.relations ?? [])
        .map((r: Node) => tableRef(r.RangeVar))
        .filter((t: TableRef) => !isNew(state, t))
        .map(
          (t: TableRef): Finding => ({
            rule: "truncate",
            severity: "danger",
            title: `TRUNCATE deletes every row in ${displayTable(t)}`,
            table: t,
            lock: "ACCESS EXCLUSIVE",
            live: { kind: "dataLoss", table: t },
          }),
        );
    case "UpdateStmt":
    case "DeleteStmt": {
      const t = tableRef(n.relation);
      if (isNew(state, t)) return [];
      const verb = stmt.kind === "UpdateStmt" ? "UPDATE" : "DELETE";
      return [
        {
          rule: "data-migration",
          severity: "warn",
          title: `${verb} ${n.whereClause ? "with" : "without"} WHERE on ${displayTable(t)} inside a migration`,
          detail:
            "Rows stay locked until the migration's transaction commits, and large backfills generate a lot of WAL.",
          table: t,
          lock: "ROW EXCLUSIVE",
          fix: "Backfill in batches outside the migration, or keep it but check the row count below first.",
          live: n.whereClause ? undefined : { kind: "dataLoss", table: t },
        },
      ];
    }
    case "RefreshMatViewStmt": {
      if (n.concurrent) return [];
      const t = tableRef(n.relation);
      return [
        {
          rule: "refresh-matview",
          severity: "warn",
          title: `REFRESH MATERIALIZED VIEW ${displayTable(t)} blocks all reads of the view while it runs`,
          table: t,
          lock: "ACCESS EXCLUSIVE",
          fix: "Use REFRESH MATERIALIZED VIEW CONCURRENTLY (needs a unique index on the view).",
        },
      ];
    }
    case "ClusterStmt":
    case "VacuumStmt": {
      const full =
        stmt.kind === "ClusterStmt" ||
        (n.options ?? []).some((o: Node) => o?.DefElem?.defname === "full");
      if (!full) return [];
      const rels: TableRef[] =
        stmt.kind === "ClusterStmt"
          ? n.relation
            ? [tableRef(n.relation)]
            : []
          : (n.rels ?? []).map((r: Node) => tableRef(r.VacuumRelation?.relation));
      return rels.map((t) => ({
        rule: "table-rewrite",
        severity: "warn",
        title: `${stmt.kind === "ClusterStmt" ? "CLUSTER" : "VACUUM FULL"} rewrites ${displayTable(t)} and blocks all access`,
        table: t,
        lock: "ACCESS EXCLUSIVE",
        rewrite: true,
        fix: "Use pg_repack, or run it in a maintenance window.",
      }));
    }
    case "AlterEnumStmt":
      return [];
    default:
      return [];
  }
}

async function alterTable(n: Node, state: BatchState): Promise<Finding[]> {
  const t = tableRef(n.relation);
  const key = tableKey(t);
  const fresh = isNew(state, t);
  const out: Finding[] = [];
  const addedHere: string[] = [];
  for (const c of n.cmds ?? []) {
    const cmd = c.AlterTableCmd;
    if (!cmd) continue;
    switch (cmd.subtype) {
      case "AT_AddColumn": {
        const col = cmd.def?.ColumnDef;
        if (!col) break;
        const constraints: Node[] = (col.constraints ?? []).map((x: Node) => x.Constraint);
        const notNull = constraints.some((x) => x?.contype === "CONSTR_NOTNULL");
        const def = constraints.find((x) => x?.contype === "CONSTR_DEFAULT");
        const generated = constraints.find((x) => x?.contype === "CONSTR_GENERATED");
        const identity = constraints.find((x) => x?.contype === "CONSTR_IDENTITY");
        const tn = typeName(col.typeName);
        const serial = /^(small|big)?serial\d?$/.test(tn);
        const cols = state.addedColumns.get(key) ?? new Map();
        cols.set(col.colname, { hasDefault: !!def || !!generated || !!identity || serial });
        state.addedColumns.set(key, cols);
        if (!fresh) addedHere.push(col.colname);
        if (fresh) break;
        if (notNull && !def && !generated && !identity && !serial) {
          out.push({
            rule: "add-not-null-without-default",
            severity: "danger",
            title: `ADD COLUMN ${col.colname} NOT NULL without a default fails if ${displayTable(t)} has any rows`,
            table: t,
            lock: "ACCESS EXCLUSIVE",
            fix: `Add the column as nullable, backfill it, then SET NOT NULL (see set-not-null), or give it a DEFAULT.`,
            live: { kind: "nonEmpty", table: t },
          });
        }
        if (generated || identity || serial) {
          out.push({
            rule: "add-column-rewrite",
            severity: "warn",
            title: `ADD COLUMN ${col.colname} ${generated ? "GENERATED … STORED" : identity ? "GENERATED AS IDENTITY" : tn.toUpperCase()} rewrites ${displayTable(t)}`,
            detail:
              "Every existing row gets a new value, so Postgres rewrites the table and its indexes.",
            table: t,
            lock: "ACCESS EXCLUSIVE",
            rewrite: true,
            fix: "Add a plain nullable column, backfill in batches, then add the default/constraint.",
          });
        } else if (def) {
          const fns = [...calledFunctions(def.raw_expr)];
          const knownVolatile = fns.some((f) => VOLATILE_FUNCTIONS.has(f));
          if (fns.length)
            out.push({
              rule: "add-column-volatile-default",
              severity: knownVolatile ? "warn" : "info",
              title: `ADD COLUMN ${col.colname} DEFAULT ${(await exprToSql(def.raw_expr)).slice(0, 60)} ${knownVolatile ? "is computed per row, so it rewrites" : "may rewrite"} ${displayTable(t)}`,
              detail:
                "A default from a volatile function (random(), gen_random_uuid(), clock_timestamp(), …) is computed per row, forcing a full table rewrite. Constant and stable defaults (now(), 'x', 0) are instant on Postgres 11+.",
              table: t,
              lock: "ACCESS EXCLUSIVE",
              rewrite: fns.some((f) => VOLATILE_FUNCTIONS.has(f)),
              fix: "Add the column without a default (or with a constant), backfill in batches, then SET DEFAULT for new rows.",
              live: { kind: "volatileDefault", table: t, column: col.colname, functions: fns },
            });
        }
        break;
      }
      case "AT_DropColumn": {
        const list = state.droppedInMigration.get(key) ?? [];
        list.push(cmd.name);
        state.droppedInMigration.set(key, list);
        if (fresh) break;
        out.push({
          rule: "drop-column",
          severity: "warn",
          title: `DROP COLUMN ${displayTable(t)}.${cmd.name} deletes its data and breaks app code still reading it`,
          detail:
            "During a rolling deploy the previous app version is still running and may select this column.",
          table: t,
          lock: "ACCESS EXCLUSIVE",
          fix: "Deploy code that stops using the column first, then drop it in a later release.",
          live: { kind: "dataLoss", table: t, column: cmd.name },
        });
        break;
      }
      case "AT_SetNotNull": {
        if (fresh) break;
        const added = state.addedColumns.get(key)?.get(cmd.name);
        if (added && !added.hasDefault) {
          out.push({
            rule: "set-not-null",
            severity: "danger",
            title: `SET NOT NULL on ${cmd.name}, which was just added without a default: fails if ${displayTable(t)} has rows`,
            table: t,
            lock: "ACCESS EXCLUSIVE",
            live: { kind: "nonEmpty", table: t },
          });
          break;
        }
        out.push({
          rule: "set-not-null",
          severity: "warn",
          title: `SET NOT NULL on ${displayTable(t)}.${cmd.name} scans the whole table while blocking all reads and writes`,
          table: t,
          lock: "ACCESS EXCLUSIVE",
          scan: true,
          fix: [
            `ALTER TABLE ${quoteTable(t)} ADD CONSTRAINT ${quoteIdent(`${t.name}_${cmd.name}_not_null`)} CHECK (${quoteIdent(cmd.name)} IS NOT NULL) NOT VALID;`,
            `ALTER TABLE ${quoteTable(t)} VALIDATE CONSTRAINT ${quoteIdent(`${t.name}_${cmd.name}_not_null`)};  -- no long lock`,
            `ALTER TABLE ${quoteTable(t)} ALTER COLUMN ${quoteIdent(cmd.name)} SET NOT NULL;  -- instant on PG 12+, uses the check`,
            `ALTER TABLE ${quoteTable(t)} DROP CONSTRAINT ${quoteIdent(`${t.name}_${cmd.name}_not_null`)};`,
          ].join("\n"),
          live: { kind: "nulls", table: t, column: cmd.name },
        });
        break;
      }
      case "AT_AlterColumnType": {
        if (fresh) break;
        const def = cmd.def?.ColumnDef;
        const to = typeName(def?.typeName);
        const enumName = names(def?.typeName?.names).pop() ?? "";
        const createdEnum = state.createdEnums.get(enumName);
        const safe = !def?.raw_default && SAFE_TYPE_CHANGE.some((f) => f(undefined, to));
        out.push({
          rule: "change-column-type",
          severity: safe ? "info" : "warn",
          title: safe
            ? `ALTER COLUMN ${cmd.name} TYPE ${to} on ${displayTable(t)} (no rewrite for varchar/text widening)`
            : `ALTER COLUMN ${cmd.name} TYPE ${to} rewrites ${displayTable(t)} and its indexes while blocking all access`,
          table: t,
          lock: "ACCESS EXCLUSIVE",
          rewrite: !safe,
          fix: safe
            ? undefined
            : "Add a new column, dual-write and backfill it in batches, then switch reads and drop the old one.",
          live: createdEnum
            ? { kind: "enumValues", table: t, column: cmd.name, allowed: createdEnum, enumName }
            : def?.raw_default
              ? undefined
              : { kind: "castFailures", table: t, column: cmd.name, type: to },
        });
        break;
      }
      case "AT_AddConstraint": {
        const con = cmd.def?.Constraint;
        if (!con || fresh) break;
        const notValid = con.skip_validation === true || con.initially_valid === false;
        if (con.contype === "CONSTR_FOREIGN") {
          const ref = tableRef(con.pktable);
          if (notValid) break;
          out.push({
            rule: "add-foreign-key",
            severity: "warn",
            title: `ADD FOREIGN KEY on ${displayTable(t)} → ${displayTable(ref)} scans the table and blocks writes on both tables`,
            table: t,
            lock: "SHARE ROW EXCLUSIVE",
            scan: true,
            fix: `Add it with NOT VALID (instant), then run ALTER TABLE ${quoteTable(t)} VALIDATE CONSTRAINT ${quoteIdent(con.conname ?? "<name>")}; separately (does not block writes).`,
            live: {
              kind: "orphans",
              table: t,
              columns: names(con.fk_attrs),
              refTable: ref,
              refColumns: con.pk_attrs?.length ? names(con.pk_attrs) : undefined,
            },
          });
        } else if (con.contype === "CONSTR_CHECK") {
          if (notValid) break;
          out.push({
            rule: "add-check-constraint",
            severity: "warn",
            title: `ADD CHECK constraint on ${displayTable(t)} scans the whole table while blocking all access`,
            table: t,
            lock: "ACCESS EXCLUSIVE",
            scan: true,
            fix: "Add it with NOT VALID, then VALIDATE CONSTRAINT in a separate statement.",
            live: { kind: "checkViolations", table: t, expr: await exprToSql(con.raw_expr) },
          });
        } else if (con.contype === "CONSTR_UNIQUE" || con.contype === "CONSTR_PRIMARY") {
          if (con.indexname) break; // USING INDEX: instant
          const cols = names(con.keys);
          out.push({
            rule: "add-unique-constraint",
            severity: "warn",
            title: `ADD ${con.contype === "CONSTR_PRIMARY" ? "PRIMARY KEY" : "UNIQUE"} (${cols.join(", ")}) builds an index on ${displayTable(t)} while blocking all access`,
            table: t,
            lock: "ACCESS EXCLUSIVE",
            scan: true,
            fix: `CREATE UNIQUE INDEX CONCURRENTLY first, then ADD CONSTRAINT … ${con.contype === "CONSTR_PRIMARY" ? "PRIMARY KEY" : "UNIQUE"} USING INDEX <name>.`,
            live: {
              kind: "duplicates",
              table: t,
              exprs: cols.map(quoteIdent),
              nullsNotDistinct: con.contype === "CONSTR_PRIMARY" || con.nulls_not_distinct === true,
            },
          });
        }
        break;
      }
      case "AT_SetLogged":
      case "AT_SetUnLogged":
        if (fresh) break;
        out.push({
          rule: "table-rewrite",
          severity: "warn",
          title: `SET ${cmd.subtype === "AT_SetLogged" ? "LOGGED" : "UNLOGGED"} rewrites ${displayTable(t)}`,
          table: t,
          lock: "ACCESS EXCLUSIVE",
          rewrite: true,
        });
        break;
      default:
        break;
    }
  }
  out.push(...renameGuesses(t, addedHere, state, out));
  return out;
}

/** Longest common substring length, case-insensitive. */
function commonLength(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let best = 0;
  for (let i = 0; i < x.length; i++)
    for (let j = 0; j < y.length; j++) {
      let k = 0;
      while (x[i + k] && x[i + k] === y[j + k]) k++;
      best = Math.max(best, k);
    }
  return best;
}

/**
 * Prisma and Drizzle turn a renamed field into DROP COLUMN + ADD COLUMN. Pair each column
 * dropped in this migration with the most similarly named column added on the same table.
 */
function renameGuesses(t: TableRef, added: string[], state: BatchState, out: Finding[]): Finding[] {
  const key = tableKey(t);
  const dropped = state.droppedInMigration.get(key) ?? [];
  if (!dropped.length || !added.length) return [];
  const guesses: Finding[] = [];
  const free = [...added];
  for (const old of [...dropped]) {
    if (!free.length) break;
    const ranked = [...free].sort((a, b) => commonLength(old, b) - commonLength(old, a));
    const best = ranked[0] as string;
    free.splice(free.indexOf(best), 1);
    dropped.splice(dropped.indexOf(old), 1);
    // The rename finding replaces the plain drop-column one for the same column.
    const i = out.findIndex(
      (f) => f.rule === "drop-column" && f.live?.kind === "dataLoss" && f.live.column === old,
    );
    if (i >= 0) out.splice(i, 1);
    const others = ranked.slice(1);
    guesses.push({
      rule: "rename-as-drop-add",
      severity: "danger",
      title: `Looks like a rename of ${displayTable(t)}.${old} → ${best}${others.length ? ` (or ${others.join(", ")})` : ""}, done as DROP + ADD: ${old}'s data is deleted`,
      detail:
        "Prisma and Drizzle generate DROP COLUMN + ADD COLUMN when a field is renamed in the schema.",
      table: t,
      fix: `If this is a rename, use instead:\nALTER TABLE ${quoteTable(t)} RENAME COLUMN ${quoteIdent(old)} TO ${quoteIdent(best)};\n(Prisma: create the migration with --create-only and edit it. Drizzle: answer "rename" when drizzle-kit generate asks.)`,
      live: { kind: "dataLoss", table: t, column: old },
    });
  }
  return guesses;
}

async function createIndex(n: Node, state: BatchState, tool: Project["tool"]): Promise<Finding[]> {
  const t = tableRef(n.relation);
  const out: Finding[] = [];
  if (n.concurrent && state.inTransaction)
    out.push({
      rule: "concurrently-in-transaction",
      severity: "fail",
      title:
        "CREATE INDEX CONCURRENTLY cannot run inside a transaction block: this migration will fail",
      detail:
        tool === "drizzle"
          ? "drizzle-kit migrate wraps all pending migrations in one transaction."
          : "Prisma wraps a migration file with more than one statement in a transaction (error 25001). A failed attempt can leave an INVALID index behind.",
      table: t,
      fix: CONCURRENTLY_FIX[tool],
    });
  if (isNew(state, t)) return out;
  const exprs = await Promise.all(
    (n.indexParams ?? []).map(async (p: Node) => {
      const e = p.IndexElem;
      return e?.name ? quoteIdent(e.name) : `(${await exprToSql(e?.expr)})`;
    }),
  );
  if (!n.concurrent)
    out.push({
      rule: "create-index-blocking",
      severity: "warn",
      title: `CREATE ${n.unique ? "UNIQUE " : ""}INDEX without CONCURRENTLY blocks writes to ${displayTable(t)} until it is built`,
      table: t,
      lock: "SHARE",
      scan: true,
      fix:
        tool === "prisma"
          ? "Use CREATE INDEX CONCURRENTLY, alone in its own migration file (Prisma only wraps multi-statement files in a transaction)."
          : tool === "drizzle"
            ? "Create it with CREATE INDEX CONCURRENTLY outside drizzle-kit migrate (which always runs in a transaction), keeping IF NOT EXISTS in the migration."
            : "Use CREATE INDEX CONCURRENTLY outside a transaction.",
    });
  if (n.unique)
    out.push({
      rule: "unique-index-duplicates",
      severity: "info",
      title: `UNIQUE index on ${displayTable(t)} (${exprs.join(", ")}) fails if existing rows have duplicates`,
      table: t,
      live: {
        kind: "duplicates",
        table: t,
        exprs,
        where: n.whereClause ? await exprToSql(n.whereClause) : undefined,
        nullsNotDistinct: n.nulls_not_distinct === true,
      },
    });
  return out;
}

function drop(n: Node, state: BatchState): Finding[] {
  if (n.removeType === "OBJECT_TABLE") {
    return (n.objects ?? []).flatMap((o: Node) => {
      const parts = names(o?.List?.items);
      const t: TableRef =
        parts.length > 1 ? { schema: parts[0], name: parts[1] ?? "" } : { name: parts[0] ?? "" };
      if (isNew(state, t)) return [];
      return [
        {
          rule: "drop-table",
          severity: "danger",
          title: `DROP TABLE ${displayTable(t)} deletes all its data`,
          table: t,
          lock: "ACCESS EXCLUSIVE",
          fix: "Make sure no deployed code uses the table, and take a backup (or rename it first and drop later).",
          live: { kind: "dataLoss", table: t },
        } satisfies Finding,
      ];
    });
  }
  if (n.removeType === "OBJECT_INDEX" && !n.concurrent)
    return [
      {
        rule: "drop-index-blocking",
        severity: "info",
        title: "DROP INDEX without CONCURRENTLY briefly blocks all access to its table",
        lock: "ACCESS EXCLUSIVE",
        fix: "Use DROP INDEX CONCURRENTLY outside a transaction.",
      },
    ];
  return [];
}

function rename(n: Node, state: BatchState): Finding[] {
  if (n.renameType === "OBJECT_COLUMN") {
    const t = tableRef(n.relation);
    if (isNew(state, t)) return [];
    return [
      {
        rule: "rename-column",
        severity: "warn",
        title: `RENAME COLUMN ${displayTable(t)}.${n.subname} → ${n.newname} breaks app code still using the old name`,
        detail: "During a deploy the previous app version keeps querying the old column name.",
        table: t,
        lock: "ACCESS EXCLUSIVE",
        fix: "Add the new column, dual-write, backfill, switch reads, then drop the old column. Or accept a short error window.",
      },
    ];
  }
  if (n.renameType === "OBJECT_TABLE") {
    const t = tableRef(n.relation);
    if (isNew(state, t)) return [];
    return [
      {
        rule: "rename-table",
        severity: "warn",
        title: `RENAME TABLE ${displayTable(t)} → ${n.newname} breaks app code still using the old name`,
        table: t,
        lock: "ACCESS EXCLUSIVE",
        fix: "Rename, then create a view with the old name until all code is updated.",
      },
    ];
  }
  return [];
}
