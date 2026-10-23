import { DriftChecker } from "./drift.js";
import { Db, type LiveOptions, rateBySize, runLiveCheck } from "./live.js";
import { analyze, newBatchState } from "./rules/index.js";
import { displayTable, parseStatements, SqlParseError, tableKey } from "./sql.js";
import type {
  Finding,
  Migration,
  Project,
  Report,
  StatementReport,
  TableRef,
  TableStats,
} from "./types.js";

export interface CheckOptions extends Partial<LiveOptions> {
  databaseUrl?: string;
  /** Check every migration instead of only pending ones. */
  all?: boolean;
  /** Without a database: how many of the newest migrations to check. */
  last?: number;
  /** Plain SQL runner: does it wrap each file in a transaction? */
  transaction?: Project["transaction"];
  /** Seconds a transaction must be open to count as blocking. */
  blockingSeconds?: number;
}

/** Decide which migrations to check: pending ones when a database is available. */
export async function selectMigrations(
  project: Project,
  db: Db | undefined,
  opts: CheckOptions,
): Promise<Migration[]> {
  const all = project.migrations;
  if (opts.all || project.tool === "sql") return all;
  if (db) {
    if (project.tool === "prisma") {
      const applied = await db.prismaApplied();
      return all.filter((m) => !applied?.has(m.name)).map((m) => ({ ...m, pending: true }));
    }
    if (project.tool === "drizzle" && project.drizzleMigrationsTable) {
      const last = await db.drizzleLastApplied(project.drizzleMigrationsTable);
      return all.filter((m) => (m.when ?? 0) > last).map((m) => ({ ...m, pending: true }));
    }
  }
  return all.slice(-Math.max(1, opts.last ?? 1));
}

function inTransaction(
  project: Project,
  statementCount: number,
  override?: Project["transaction"],
): boolean {
  const mode = override ?? project.transaction;
  if (mode === "per-file" || mode === "all-pending") return true;
  if (mode === "per-file-if-multiple") return statementCount > 1;
  return false;
}

const duration = (s: number) =>
  s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

export async function check(project: Project, opts: CheckOptions = {}): Promise<Report> {
  const db = opts.databaseUrl ? await Db.connect(opts.databaseUrl) : undefined;
  try {
    const migrations = await selectMigrations(project, db, opts);
    const state = newBatchState();
    const statements: StatementReport[] = [];
    // Drift only makes sense for migrations not yet applied to this database.
    const drift =
      db && (migrations.every((m) => m.pending) || project.tool === "sql")
        ? new DriftChecker(db)
        : undefined;

    for (const m of migrations) {
      state.droppedInMigration = new Map();
      let parsed: Awaited<ReturnType<typeof parseStatements>>;
      try {
        parsed = await parseStatements(m.sql);
      } catch (e) {
        statements.push({
          migration: m.name,
          file: m.file,
          line: e instanceof SqlParseError ? e.line : 1,
          sql: "",
          findings: [
            {
              rule: "syntax-error",
              severity: "fail",
              title: `Postgres can't parse this migration: ${e instanceof Error ? e.message : e}`,
            },
          ],
        });
        continue;
      }
      const explicitTx = parsed.some((s) => s.kind === "TransactionStmt");
      state.inTransaction =
        explicitTx ||
        inTransaction(
          project,
          parsed.length,
          project.tool === "sql" ? opts.transaction : undefined,
        );
      for (const s of parsed) {
        const findings = [
          ...((await drift?.check(s)) ?? []),
          ...(await analyze(s, state, project)),
        ];
        if (findings.length)
          statements.push({ migration: m.name, file: m.file, line: s.line, sql: s.text, findings });
      }
    }

    const notes: Finding[] = [];
    const locking = statements.flatMap((s) => s.findings).filter((f) => f.lock && f.table);
    if (locking.length && !state.setsLockTimeout)
      notes.push({
        rule: "missing-lock-timeout",
        severity: "warn",
        title:
          "No lock_timeout: if a long query holds a lock, this migration waits behind it and every other query on that table queues behind the migration",
        fix: "Start the migration with: SET lock_timeout = '5s';  (and retry on failure)",
      });
    if (project.tool === "drizzle" && migrations.length > 1 && locking.length)
      notes.push({
        rule: "drizzle-single-transaction",
        severity: "info",
        title: `drizzle-kit migrate runs all ${migrations.length} pending migrations in ONE transaction: locks taken early are held until the last one finishes`,
      });

    const failNote = (): Finding | undefined =>
      project.tool === "prisma"
        ? {
            rule: "prisma-failed-migration",
            severity: "info",
            title:
              "When a migration fails, Prisma records it as failed in _prisma_migrations and refuses every later `migrate deploy` (P3009) until you run `prisma migrate resolve`.",
          }
        : project.tool === "drizzle"
          ? {
              rule: "drizzle-failed-migration",
              severity: "info",
              title:
                "When a statement fails, drizzle-kit rolls back the whole batch of pending migrations.",
            }
          : undefined;

    let dbInfo: Report["db"];
    if (db) {
      const version = await db.version();
      const tables = new Map<string, TableRef>();
      for (const f of statements.flatMap((s) => s.findings)) {
        if (f.table) tables.set(tableKey(f.table), f.table);
        if (f.live?.kind === "orphans") tables.set(tableKey(f.live.refTable), f.live.refTable);
      }
      const stats = new Map<string, TableStats>();
      for (const [k, t] of tables) stats.set(k, await db.tableStats(t));
      const liveOpts: LiveOptions = {
        timeoutMs: opts.timeoutMs ?? 10_000,
        showValues: opts.showValues ?? false,
      };
      for (const f of statements.flatMap((s) => s.findings)) {
        if (f.live)
          await runLiveCheck(
            db,
            f,
            f.live,
            stats,
            { version: version.num },
            liveOpts,
            state.createdTables,
          );
        if (f.table) rateBySize(f, stats.get(tableKey(f.table)));
      }
      const canSeeAll = await db.canSeeAllSessions();
      const long = await db.longTransactions(opts.blockingSeconds ?? 30);
      // regclass::text quotes mixed-case names ("Order") and may include the schema.
      const norm = (s: string) => s.replace(/"/g, "").replace(/^public\./, "");
      const locked = new Set(locking.map((f) => norm(displayTable(f.table as TableRef))));
      const blocking = long
        .map((b) => ({ ...b, tables: b.tables.map(norm) }))
        .filter((b) => b.tables.some((t) => locked.has(t)));
      for (const b of blocking)
        notes.push({
          rule: "blocking-transaction",
          severity: "danger",
          title: `Session ${b.pid} has held locks on ${b.tables.join(", ")} for ${duration(b.seconds)} (${b.state}): running the migration now would queue behind it and block all queries on those tables`,
          detail: b.query,
          fix: `Wait for it, or end it: SELECT pg_cancel_backend(${b.pid});`,
        });
      dbInfo = { versionText: version.text, blocking, canSeeAllSessions: canSeeAll };
    }
    const note = failNote();
    if (note && statements.some((s) => s.findings.some((f) => f.severity === "fail")))
      notes.push(note);

    return {
      tool: project.tool,
      root: project.root,
      checked: migrations,
      statements,
      notes,
      db: dbInfo,
    };
  } finally {
    await db?.close();
  }
}
