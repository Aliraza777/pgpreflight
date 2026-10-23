export type Tool = "prisma" | "drizzle" | "sql";

export interface Migration {
  /** Display name: Prisma folder, Drizzle tag, or file name. */
  name: string;
  file: string;
  sql: string;
  /** True when this migration has not been applied to the connected database. */
  pending?: boolean;
  /** Drizzle journal timestamp (ms), compared with __drizzle_migrations.created_at. */
  when?: number;
}

export interface Project {
  tool: Tool;
  root: string;
  migrations: Migration[];
  /** How the tool runs migrations, which decides whether CREATE INDEX CONCURRENTLY works. */
  transaction: "per-file" | "per-file-if-multiple" | "all-pending" | "none";
  /** Drizzle only: schema and table that record applied migrations. */
  drizzleMigrationsTable?: { schema: string; table: string };
}

export interface TableRef {
  schema?: string;
  name: string;
}

export type LockMode =
  | "ACCESS EXCLUSIVE"
  | "EXCLUSIVE"
  | "SHARE ROW EXCLUSIVE"
  | "SHARE"
  | "SHARE UPDATE EXCLUSIVE"
  | "ROW EXCLUSIVE";

export type Severity = "fail" | "danger" | "warn" | "info";

/** A question only the live database can answer. */
export type LiveCheck =
  | { kind: "nulls"; table: TableRef; column: string }
  | { kind: "nonEmpty"; table: TableRef }
  | {
      kind: "duplicates";
      table: TableRef;
      exprs: string[];
      where?: string;
      nullsNotDistinct?: boolean;
    }
  | {
      kind: "orphans";
      table: TableRef;
      columns: string[];
      refTable: TableRef;
      refColumns?: string[];
    }
  | { kind: "checkViolations"; table: TableRef; expr: string }
  | { kind: "castFailures"; table: TableRef; column: string; type: string }
  | { kind: "enumValues"; table: TableRef; column: string; allowed: string[]; enumName: string }
  | { kind: "dataLoss"; table: TableRef; column?: string }
  | { kind: "volatileDefault"; table: TableRef; column: string; functions: string[] };

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  detail?: string;
  table?: TableRef;
  lock?: LockMode;
  /** Rewrites the whole table (and its indexes) while holding the lock. */
  rewrite?: boolean;
  /** Reads the whole table while holding the lock. */
  scan?: boolean;
  fix?: string;
  live?: LiveCheck;
  /** Filled in by the live database check. */
  evidence?: string[];
}

export interface StatementReport {
  migration: string;
  file: string;
  line: number;
  sql: string;
  findings: Finding[];
}

export interface TableStats {
  rows: number;
  bytes: number;
  exists: boolean;
}

export interface BlockingSession {
  pid: number;
  seconds: number;
  state: string;
  query: string;
  tables: string[];
}

export interface DbInfo {
  version: number;
  versionText: string;
  tables: Map<string, TableStats>;
  blocking: BlockingSession[];
  /** Whether other sessions' queries are visible (pg_read_all_stats or superuser). */
  canSeeAllSessions: boolean;
}

export interface Report {
  tool: Tool;
  root: string;
  checked: Migration[];
  statements: StatementReport[];
  /** Notes that apply to the whole run (transaction behavior, lock_timeout, …). */
  notes: Finding[];
  db?: { versionText: string; blocking: BlockingSession[]; canSeeAllSessions: boolean };
}
