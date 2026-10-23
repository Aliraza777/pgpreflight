import pg from "pg";
import { displayTable, quoteIdent, quoteTable, tableKey } from "./sql.js";
import type {
  BlockingSession,
  DbInfo,
  Finding,
  LiveCheck,
  Project,
  TableRef,
  TableStats,
} from "./types.js";

export interface LiveOptions {
  /** Per-query timeout for data checks. */
  timeoutMs: number;
  /** Show example offending values (off by default: they may be personal data). */
  showValues: boolean;
}

/**
 * Prisma URLs carry `?schema=x`, which libpq doesn't understand; turn it into a search_path.
 */
export function parseUrl(url: string): { connectionString: string; schema?: string } {
  try {
    const u = new URL(url);
    const schema = u.searchParams.get("schema") ?? undefined;
    u.searchParams.delete("schema");
    for (const p of [
      "connection_limit",
      "pool_timeout",
      "pgbouncer",
      "socket_timeout",
      "statement_cache_size",
    ])
      u.searchParams.delete(p);
    return { connectionString: u.toString(), schema };
  } catch {
    return { connectionString: url };
  }
}

export class Db {
  private constructor(
    private client: pg.Client,
    readonly schema?: string,
  ) {}

  static async connect(url: string): Promise<Db> {
    const { connectionString, schema } = parseUrl(url);
    const client = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 10_000,
      application_name: "pgpreflight",
    });
    await client.connect();
    // Everything pgpreflight runs is a read; make the server enforce that.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET lock_timeout = '3s'");
    if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
    return new Db(client, schema);
  }

  async close() {
    await this.client.end().catch(() => {});
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
    timeoutMs = 10_000,
  ) {
    await this.client.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    return (await this.client.query<T>(sql, params)).rows;
  }

  async version(): Promise<{ num: number; text: string }> {
    const [r] = await this.query<{ v: string; t: string }>(
      "SELECT current_setting('server_version_num') v, version() t",
    );
    return { num: Number(r?.v ?? 0), text: (r?.t ?? "").split(" on ")[0] ?? "" };
  }

  /** Names of applied Prisma migrations, or undefined when the table doesn't exist. */
  async prismaApplied(): Promise<Set<string> | undefined> {
    const [exists] = await this.query<{ r: string | null }>(
      "SELECT to_regclass('_prisma_migrations')::text r",
    );
    if (!exists?.r) return undefined;
    const rows = await this.query<{ name: string }>(
      "SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    return new Set(rows.map((r) => r.name));
  }

  /** Latest applied Drizzle migration timestamp; 0 when nothing is applied. */
  async drizzleLastApplied(t: { schema: string; table: string }): Promise<number> {
    const rel = `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
    const [exists] = await this.query<{ r: string | null }>("SELECT to_regclass($1)::text r", [
      rel,
    ]);
    if (!exists?.r) return 0;
    const [row] = await this.query<{ c: string | null }>(
      `SELECT max(created_at)::text c FROM ${rel}`,
    );
    return Number(row?.c ?? 0);
  }

  async tableStats(t: TableRef): Promise<TableStats> {
    const [r] = await this.query<{ rows: string; bytes: string; heap: string }>(
      `SELECT c.reltuples::bigint::text rows, pg_total_relation_size(c.oid)::text bytes, pg_relation_size(c.oid)::text heap
         FROM pg_class c WHERE c.oid = to_regclass($1)`,
      [quoteTable(t)],
    );
    if (!r) return { rows: 0, bytes: 0, exists: false };
    let rows = Number(r.rows);
    // reltuples is -1 (PG 14+) or 0 when the table was never analyzed: count small tables exactly.
    if (rows <= 0 && Number(r.heap) < 256 * 1024 * 1024) {
      const [c] = await this.query<{ n: string }>(
        `SELECT count(*)::text n FROM ${quoteTable(t)}`,
        [],
        5_000,
      ).catch(() => [{ n: "0" }]);
      rows = Number(c?.n ?? 0);
    }
    return { rows: Math.max(0, rows), bytes: Number(r.bytes), exists: true };
  }

  async canSeeAllSessions(): Promise<boolean> {
    const [r] = await this.query<{ ok: boolean }>(
      "SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR pg_has_role(current_user, 'pg_read_all_stats', 'member') ok",
    );
    return !!r?.ok;
  }

  /** Transactions open for more than `minSeconds`, with the tables they hold locks on. */
  async longTransactions(minSeconds = 30): Promise<BlockingSession[]> {
    const rows = await this.query<{
      pid: number;
      secs: number;
      state: string;
      query: string;
      tables: string[] | null;
    }>(
      `SELECT a.pid, extract(epoch FROM now() - a.xact_start)::int secs, coalesce(a.state, '') state,
              left(coalesce(a.query, ''), 160) query,
              array_remove(array_agg(DISTINCT l.relation::regclass::text), NULL) tables
         FROM pg_stat_activity a
         LEFT JOIN pg_locks l ON l.pid = a.pid AND l.relation IS NOT NULL AND l.granted
              AND (SELECT relkind FROM pg_class WHERE oid = l.relation) IN ('r', 'p', 'm')
        WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
          AND a.xact_start IS NOT NULL AND now() - a.xact_start > make_interval(secs => $1)
        GROUP BY a.pid, a.xact_start, a.state, a.query
        ORDER BY secs DESC LIMIT 20`,
      [minSeconds],
    );
    return rows.map((r) => ({
      pid: r.pid,
      seconds: r.secs,
      state: r.state,
      query: r.query,
      tables: r.tables ?? [],
    }));
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");
export const fmtBytes = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(1)} GB`
    : b >= 1024 ** 2
      ? `${(b / 1024 ** 2).toFixed(0)} MB`
      : `${Math.max(1, Math.round(b / 1024))} kB`;

/** Lock modes that stop normal reads or writes while held. */
const BLOCKING = new Set(["ACCESS EXCLUSIVE", "EXCLUSIVE", "SHARE ROW EXCLUSIVE", "SHARE"]);

export const SIZE = {
  warnRows: 100_000,
  dangerRows: 1_000_000,
  warnBytes: 100 * 1024 ** 2,
  dangerBytes: 1024 ** 3,
};

/** Re-rate a finding by how big its table really is. */
export function rateBySize(f: Finding, stats: TableStats | undefined): void {
  if (!stats?.exists || !f.lock || !BLOCKING.has(f.lock) || !(f.rewrite || f.scan)) return;
  if (f.severity === "fail") return;
  const what = f.rewrite ? "rewrites" : "scans";
  const size = `${fmt(stats.rows)} rows, ${fmtBytes(stats.bytes)}`;
  if (stats.rows >= SIZE.dangerRows || stats.bytes >= SIZE.dangerBytes) {
    f.severity = "danger";
    f.evidence = [
      ...(f.evidence ?? []),
      `${what} ${size} while holding ${f.lock}: expect a long outage on this table`,
    ];
  } else if (stats.rows >= SIZE.warnRows || stats.bytes >= SIZE.warnBytes) {
    f.severity = f.severity === "danger" ? "danger" : "warn";
    f.evidence = [...(f.evidence ?? []), `${what} ${size} while holding ${f.lock}`];
  } else {
    if (f.severity !== "danger") f.severity = "info";
    f.evidence = [...(f.evidence ?? []), `table is small (${size}): the lock is held only briefly`];
  }
}

const notNull = (exprs: string[]) => exprs.map((e) => `${e} IS NOT NULL`).join(" AND ");

/** Answer a finding's live question and update its severity and evidence. */
export async function runLiveCheck(
  db: Db,
  f: Finding,
  check: LiveCheck,
  stats: Map<string, TableStats>,
  info: { version: number },
  opts: LiveOptions,
  createdTables: Set<string>,
): Promise<void> {
  const ev = (s: string) => {
    f.evidence = [...(f.evidence ?? []), s];
  };
  const fail = (s: string) => {
    f.severity = "fail";
    ev(s);
  };
  const t = check.table;
  const st = stats.get(tableKey(t));
  if (!st?.exists) {
    if (!createdTables.has(tableKey(t)))
      ev(`table ${displayTable(t)} not found in the database (wrong database or schema?)`);
    return;
  }
  const q = quoteTable(t);
  const timeout = opts.timeoutMs;
  try {
    switch (check.kind) {
      case "nonEmpty": {
        const [r] = await db.query<{ e: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${q}) e`,
          [],
          timeout,
        );
        if (r?.e)
          fail(`${displayTable(t)} has rows (≈${fmt(st.rows)}), so this statement WILL FAIL`);
        else {
          f.severity = "info";
          ev(`${displayTable(t)} is empty, so this is safe right now`);
        }
        break;
      }
      case "nulls": {
        // (NOTNULL is a keyword, so the alias must not be "notnull".)
        const [col] = await db.query<{ is_not_null: boolean }>(
          "SELECT attnotnull AS is_not_null FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped",
          [q, check.column],
        );
        if (col?.is_not_null) {
          f.severity = "info";
          f.scan = false;
          ev(`${check.column} is already NOT NULL: no-op`);
          break;
        }
        const checks = await db.query<{ def: string }>(
          "SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'c' AND convalidated",
          [q],
        );
        const covered = checks.some((c) =>
          new RegExp(
            `\\(\\(?"?${check.column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"? IS NOT NULL\\)?\\)`,
          ).test(c.def),
        );
        const [r] = await db.query<{ n: string }>(
          `SELECT count(*)::text n FROM ${q} WHERE ${quoteIdent(check.column)} IS NULL`,
          [],
          timeout,
        );
        const n = Number(r?.n ?? 0);
        if (n > 0) fail(`${fmt(n)} rows have NULL in ${check.column}, so SET NOT NULL WILL FAIL`);
        else if (covered && info.version >= 120000) {
          f.severity = "info";
          f.scan = false;
          ev(`a validated CHECK (${check.column} IS NOT NULL) exists, so Postgres skips the scan`);
        } else ev(`no NULLs in ${check.column} today`);
        break;
      }
      case "duplicates": {
        const nonNull = check.nullsNotDistinct ? "" : notNull(check.exprs);
        const where = [nonNull, check.where ? `(${check.where})` : ""]
          .filter(Boolean)
          .join(" AND ");
        const group = check.exprs.join(", ");
        const [r] = await db.query<{ groups: string; rows: string }>(
          `SELECT count(*)::text groups, coalesce(sum(n), 0)::text rows FROM (
             SELECT count(*) n FROM ${q} ${where ? `WHERE ${where}` : ""} GROUP BY ${group} HAVING count(*) > 1) d`,
          [],
          timeout,
        );
        const groups = Number(r?.groups ?? 0);
        if (groups > 0) {
          let sample = "";
          if (opts.showValues) {
            const rows = await db.query<{ v: string }>(
              `SELECT (${check.exprs.map((e) => `${e}::text`).join(" || ', ' || ")}) v FROM ${q} ${where ? `WHERE ${where}` : ""} GROUP BY ${group} HAVING count(*) > 1 LIMIT 3`,
              [],
              timeout,
            );
            sample = ` e.g. ${rows.map((x) => JSON.stringify(x.v)).join(", ")}`;
          }
          fail(
            `${fmt(groups)} duplicate value(s) across ${fmt(Number(r?.rows))} rows${sample}, so the unique index WILL FAIL`,
          );
        } else ev("no duplicates today");
        break;
      }
      case "orphans": {
        let refCols = check.refColumns;
        if (!refCols?.length) {
          const pk = await db.query<{ a: string }>(
            `SELECT a.attname a FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
            [quoteTable(check.refTable)],
          );
          refCols = pk.map((x) => x.a);
        }
        if (refCols.length !== check.columns.length) break;
        const c = check.columns.map(quoteIdent);
        const p = refCols.map(quoteIdent);
        const refNew = createdTables.has(tableKey(check.refTable));
        const sql = refNew
          ? `SELECT count(*)::text n FROM ${q} c WHERE ${notNull(c.map((x) => `c.${x}`))}`
          : `SELECT count(*)::text n FROM ${q} c WHERE ${notNull(c.map((x) => `c.${x}`))}
               AND NOT EXISTS (SELECT 1 FROM ${quoteTable(check.refTable)} p WHERE ${c.map((x, i) => `p.${p[i]} = c.${x}`).join(" AND ")})`;
        const [r] = await db.query<{ n: string }>(sql, [], timeout);
        const n = Number(r?.n ?? 0);
        if (n > 0)
          fail(
            `${fmt(n)} rows in ${displayTable(t)} point to missing ${displayTable(check.refTable)} rows, so the foreign key WILL FAIL`,
          );
        else ev("every row has a matching parent today");
        break;
      }
      case "checkViolations": {
        const [r] = await db.query<{ n: string }>(
          `SELECT count(*)::text n FROM ${q} WHERE (${check.expr}) IS FALSE`,
          [],
          timeout,
        );
        const n = Number(r?.n ?? 0);
        if (n > 0) fail(`${fmt(n)} existing rows violate CHECK (${check.expr}), so it WILL FAIL`);
        else ev("all existing rows satisfy the check");
        break;
      }
      case "castFailures": {
        if (info.version < 160000) {
          ev("can't test value conversion before Postgres 16 (needs pg_input_is_valid)");
          break;
        }
        const [r] = await db.query<{ n: string }>(
          `SELECT count(*)::text n FROM ${q} WHERE ${quoteIdent(check.column)} IS NOT NULL AND NOT pg_input_is_valid(${quoteIdent(check.column)}::text, $1)`,
          [check.type],
          timeout,
        );
        const n = Number(r?.n ?? 0);
        if (n > 0)
          fail(
            `${fmt(n)} values in ${check.column} can't be converted to ${check.type}, so it WILL FAIL`,
          );
        else ev(`all current values convert to ${check.type}`);
        break;
      }
      case "enumValues": {
        const [r] = await db.query<{ n: string; vals: string[] | null }>(
          `SELECT count(*)::text n, (array_agg(DISTINCT ${quoteIdent(check.column)}::text))[1:5] vals FROM ${q}
            WHERE ${quoteIdent(check.column)} IS NOT NULL AND ${quoteIdent(check.column)}::text <> ALL($1::text[])`,
          [check.allowed],
          timeout,
        );
        const n = Number(r?.n ?? 0);
        if (n > 0)
          fail(
            `${fmt(n)} rows use enum values that ${check.enumName} no longer has (${(r?.vals ?? []).join(", ")}), so it WILL FAIL`,
          );
        else ev(`no rows use the removed enum values`);
        break;
      }
      case "dataLoss": {
        if (check.column) {
          const [r] = await db.query<{ n: string }>(
            `SELECT count(*)::text n FROM ${q} WHERE ${quoteIdent(check.column)} IS NOT NULL`,
            [],
            timeout,
          );
          const n = Number(r?.n ?? 0);
          if (n > 0) ev(`deletes ${fmt(n)} non-null value(s) in ${check.column}`);
          else {
            if (f.rule === "rename-as-drop-add" || f.rule === "drop-column") f.severity = "info";
            ev(`${check.column} has no data today`);
          }
        } else if (st.rows > 0) ev(`deletes ≈${fmt(st.rows)} rows (${fmtBytes(st.bytes)})`);
        else {
          f.severity = f.rule === "data-migration" ? "info" : f.severity;
          ev(`${displayTable(t)} is empty today`);
        }
        break;
      }
      case "volatileDefault": {
        const rows = await db.query<{ proname: string; provolatile: string }>(
          "SELECT DISTINCT proname, provolatile FROM pg_proc WHERE proname = ANY($1)",
          [check.functions],
        );
        const volatile = rows.filter((r) => r.provolatile === "v").map((r) => r.proname);
        if (volatile.length || info.version < 110000) {
          f.rewrite = true;
          f.severity = f.severity === "info" ? "warn" : f.severity;
          ev(
            info.version < 110000
              ? "Postgres before 11 rewrites the table for any default"
              : `${volatile.join(", ")} is volatile: every row is rewritten`,
          );
        } else {
          f.rewrite = false;
          f.severity = "info";
          ev(
            `the default is not volatile, so Postgres ${Math.floor(info.version / 10000)} adds the column instantly`,
          );
        }
        break;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/statement timeout/i.test(msg))
      ev(
        `could not verify within ${timeout / 1000}s (≈${fmt(st.rows)} rows). Re-run with a higher --timeout to check.`,
      );
    else ev(`could not verify: ${msg.split("\n")[0]}`);
  }
}

export type { DbInfo, Project };
