import { relative } from "node:path";
import pc from "picocolors";
import type { Finding, Report, Severity } from "./types.js";

export const ORDER: Record<Severity, number> = { fail: 0, danger: 1, warn: 2, info: 3 };

const LABEL: Record<Severity, string> = {
  fail: pc.bgRed(pc.white(pc.bold(" WILL FAIL "))),
  danger: pc.red(pc.bold("DANGER")),
  warn: pc.yellow("WARN"),
  info: pc.dim("info"),
};

export function counts(report: Report): Record<Severity, number> {
  const c: Record<Severity, number> = { fail: 0, danger: 0, warn: 0, info: 0 };
  for (const f of [...report.statements.flatMap((s) => s.findings), ...report.notes])
    c[f.severity]++;
  return c;
}

const indent = (s: string, n: number) =>
  s
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");

function finding(f: Finding, verbose: boolean): string[] {
  const lines = [`  ${LABEL[f.severity]} ${f.title}`];
  for (const e of f.evidence ?? []) lines.push(`         ${pc.cyan("↳")} ${e}`);
  if (f.detail && (verbose || f.severity !== "info")) lines.push(pc.dim(indent(f.detail, 9)));
  if (f.fix && f.severity !== "info")
    lines.push(
      `         ${pc.green("fix:")} ${f.fix.split("\n")[0]}`,
      ...f.fix
        .split("\n")
        .slice(1)
        .map((l) => pc.green(`              ${l}`)),
    );
  return lines;
}

export function renderText(report: Report, opts: { verbose?: boolean; cwd?: string } = {}): string {
  const out: string[] = [""];
  const cwd = opts.cwd ?? process.cwd();
  const pending = report.checked.some((m) => m.pending);
  const dbLine = report.db
    ? pc.dim(` · ${report.db.versionText}`)
    : pc.dim(" · no database (static checks only)");
  out.push(
    `${pc.bold("pgpreflight")} ${pc.dim(`· ${report.tool} ·`)} ${report.checked.length} ${pending ? "pending " : ""}migration${report.checked.length === 1 ? "" : "s"}${dbLine}`,
  );
  if (!report.checked.length) {
    out.push("", pc.green("  ✓ Nothing to check: no pending migrations."), "");
    return out.join("\n");
  }
  const shown = report.statements
    .map((s) => ({
      ...s,
      findings: s.findings.filter((f) => opts.verbose || f.severity !== "info"),
    }))
    .filter((s) => s.findings.length);
  let current = "";
  for (const s of shown) {
    if (s.migration !== current) {
      current = s.migration;
      out.push("", pc.bold(s.migration));
    }
    const loc = pc.dim(`${relative(cwd, s.file)}:${s.line}`);
    out.push(`  ${loc}  ${pc.dim(s.sql.replace(/\s+/g, " ").slice(0, 100))}`);
    for (const f of [...s.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]))
      out.push(...finding(f, !!opts.verbose));
  }
  const notes = report.notes.filter(
    (n) =>
      opts.verbose ||
      n.severity !== "info" ||
      n.rule === "drizzle-single-transaction" ||
      n.rule.endsWith("-failed-migration"),
  );
  if (notes.length) {
    out.push("", pc.bold("Whole run"));
    for (const n of notes) out.push(...finding(n, !!opts.verbose));
  }
  const c = counts(report);
  out.push("");
  if (c.fail || c.danger)
    out.push(
      `${pc.red("✖")} ${[c.fail && `${c.fail} will fail`, c.danger && `${c.danger} dangerous`, c.warn && `${c.warn} warning${c.warn === 1 ? "" : "s"}`].filter(Boolean).join(", ")}`,
    );
  else if (c.warn)
    out.push(`${pc.yellow("!")} ${c.warn} warning${c.warn === 1 ? "" : "s"}, nothing will fail`);
  else out.push(`${pc.green("✓")} Looks safe${report.db ? " against this database" : ""}.`);
  if (!report.db)
    out.push(
      pc.dim(
        "Static checks only. Pass --db (or set DATABASE_URL) to check against real data: nulls, duplicates, orphans, table sizes, blocking sessions.",
      ),
    );
  if (report.db && !report.db.canSeeAllSessions)
    out.push(
      pc.dim(
        "Your role can't see other users' sessions; grant pg_read_all_stats to detect blocking transactions.",
      ),
    );
  out.push("");
  return out.join("\n");
}

export function renderJson(report: Report): string {
  return JSON.stringify(
    {
      ...report,
      checked: report.checked.map(({ sql: _sql, ...m }) => m),
      summary: counts(report),
    },
    null,
    2,
  );
}

/** Markdown for PR comments. */
export function renderMarkdown(report: Report, cwd = process.cwd()): string {
  const c = counts(report);
  const icon = c.fail ? "🛑" : c.danger ? "⚠️" : c.warn ? "🟡" : "✅";
  const out = [
    `### ${icon} pgpreflight: ${report.checked.length} migration${report.checked.length === 1 ? "" : "s"} checked`,
    "",
    `${c.fail} will fail · ${c.danger} dangerous · ${c.warn} warnings${report.db ? ` · checked against ${report.db.versionText}` : " · static checks only"}`,
    "",
  ];
  for (const s of report.statements) {
    const fs = s.findings.filter((f) => f.severity !== "info");
    if (!fs.length) continue;
    out.push(
      `**${s.migration}** \`${relative(cwd, s.file)}:${s.line}\``,
      "",
      "```sql",
      s.sql.slice(0, 400),
      "```",
    );
    for (const f of fs) {
      out.push(
        `- **${f.severity === "fail" ? "WILL FAIL" : f.severity.toUpperCase()}** ${f.title}`,
      );
      for (const e of f.evidence ?? []) out.push(`  - ${e}`);
      if (f.fix)
        out.push(
          "",
          "  <details><summary>Fix</summary>",
          "",
          "  ```sql",
          indent(f.fix, 2),
          "  ```",
          "  </details>",
          "",
        );
    }
    out.push("");
  }
  for (const n of report.notes.filter((x) => x.severity !== "info"))
    out.push(`- **${n.severity.toUpperCase()}** ${n.title}`);
  return out.join("\n");
}
