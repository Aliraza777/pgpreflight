import { parse } from "libpg-query";
import { deparse } from "pgsql-deparser";
import type { TableRef } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: libpg-query ASTs are deeply polymorphic
export type Node = any;

export interface Statement {
  /** The statement text, trimmed, without trailing semicolon. */
  text: string;
  /** 1-based line in the file where the statement starts. */
  line: number;
  /** Node type, e.g. "AlterTableStmt". */
  kind: string;
  node: Node;
}

export class SqlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/** Split a migration into statements with Postgres's own parser. */
export async function parseStatements(sql: string): Promise<Statement[]> {
  let result: { stmts?: Array<{ stmt?: Node; stmt_location?: number; stmt_len?: number }> };
  try {
    result = await parse(sql);
  } catch (e) {
    const err = e as { cursorPosition?: number; sqlDetails?: { cursorPosition?: number } };
    const cursor = err.sqlDetails?.cursorPosition ?? err.cursorPosition;
    throw new SqlParseError(
      e instanceof Error ? e.message : String(e),
      cursor ? lineAt(sql, cursor) : 1,
    );
  }
  const out: Statement[] = [];
  for (const s of result.stmts ?? []) {
    if (!s.stmt) continue;
    const start = s.stmt_location ?? 0;
    const end = s.stmt_len ? start + s.stmt_len : sql.length;
    const raw = sql.slice(start, end);
    // Skip leading comments/blank lines so the reported line is the statement itself.
    const lead = raw.match(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/)?.[0].length ?? 0;
    const kind = Object.keys(s.stmt)[0] ?? "Unknown";
    out.push({
      text: raw.slice(lead).trim().replace(/;$/, ""),
      line: lineAt(sql, start + lead),
      kind,
      node: s.stmt[kind],
    });
  }
  return out;
}

export function tableRef(rangeVar: Node): TableRef {
  return { schema: rangeVar?.schemaname || undefined, name: rangeVar?.relname ?? "?" };
}

/** Lookup key; unqualified names resolve against `public`. */
export const tableKey = (t: TableRef) => `${t.schema ?? "public"}.${t.name}`;

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const quoteTable = (t: TableRef) =>
  t.schema ? `${quoteIdent(t.schema)}.${quoteIdent(t.name)}` : quoteIdent(t.name);
export const displayTable = (t: TableRef) => (t.schema ? `${t.schema}.${t.name}` : t.name);

/** Turn an expression node back into SQL. */
export async function exprToSql(node: Node): Promise<string> {
  return (await deparse(node, {})).replace(/\s+/g, " ").trim();
}

/** `String` nodes in name lists, e.g. funcname or typeName.names. */
export function names(list: Node[] | undefined): string[] {
  return (list ?? []).map((n) => n?.String?.sval ?? n?.String?.str ?? "").filter(Boolean);
}

/** Internal names the parser produces, shown as people write them. */
const TYPE_ALIASES: Record<string, string> = {
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
  bpchar: "char",
};

export function typeName(tn: Node): string {
  const parts = names(tn?.names).filter((p) => p !== "pg_catalog");
  const joined = parts.join(".");
  const base = TYPE_ALIASES[joined] ?? joined;
  const mods = (tn?.typmods ?? [])
    .map((m: Node) => m?.A_Const?.ival?.ival ?? m?.A_Const?.ival ?? "")
    .filter((v: unknown) => v !== "" && v !== undefined);
  const arr = tn?.arrayBounds?.length ? "[]" : "";
  return `${base}${mods.length ? `(${mods.join(",")})` : ""}${arr}`;
}

/** Function names called anywhere inside an expression tree. */
export function calledFunctions(node: Node, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return acc;
  if (node.FuncCall) {
    const parts = names(node.FuncCall.funcname);
    const name = parts[parts.length - 1];
    if (name) acc.add(name.toLowerCase());
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) for (const x of v) calledFunctions(x, acc);
    else if (v && typeof v === "object") calledFunctions(v, acc);
  }
  return acc;
}
