import { Command, Option } from "commander";
import pc from "picocolors";
import { check } from "./check.js";
import { discover } from "./discover.js";
import { ORDER, renderJson, renderMarkdown, renderText } from "./report.js";
import type { Severity } from "./types.js";
import { VERSION } from "./version.js";

const program = new Command()
  .name("pgpreflight")
  .description(
    "Pre-flight check for Postgres migrations: finds the ones that will fail, lock big tables or lose data, by checking them against your real database.",
  )
  .version(VERSION)
  .argument("[paths...]", "migration files or directories (default: auto-detect Prisma or Drizzle)")
  .option("-d, --db <url>", "Postgres URL to check against, read-only (default: $DATABASE_URL)")
  .option("--no-db", "static checks only, even if DATABASE_URL is set")
  .option("-a, --all", "check every migration, not just pending ones")
  .option(
    "--last <n>",
    "without a database, how many newest migrations to check",
    (v) => Number.parseInt(v, 10),
    1,
  )
  .addOption(
    new Option("--transaction <mode>", "plain SQL: how your runner wraps files")
      .choices(["per-file", "none"])
      .default("none"),
  )
  .option("--timeout <seconds>", "time limit per data check", (v) => Number.parseFloat(v), 10)
  .option("--show-values", "show example duplicate values (may include personal data)")
  .option(
    "--blocking-after <seconds>",
    "report open transactions older than this that hold locks on affected tables",
    (v) => Number.parseFloat(v),
    30,
  )
  .addOption(
    new Option("-f, --format <format>", "output format")
      .choices(["text", "json", "md"])
      .default("text"),
  )
  .addOption(
    new Option("--fail-on <severity>", "exit with code 1 at this severity or worse")
      .choices(["fail", "danger", "warn", "never"])
      .default("danger"),
  )
  .option("-v, --verbose", "also show informational findings")
  .action(async (paths: string[], opts) => {
    const project = discover(process.cwd(), paths);
    const databaseUrl =
      opts.db === false
        ? undefined
        : typeof opts.db === "string"
          ? opts.db
          : process.env.DATABASE_URL;
    const report = await check(project, {
      databaseUrl,
      all: opts.all,
      last: opts.last,
      transaction: opts.transaction,
      timeoutMs: opts.timeout * 1000,
      showValues: opts.showValues,
      blockingSeconds: opts.blockingAfter,
    });
    const out =
      opts.format === "json"
        ? renderJson(report)
        : opts.format === "md"
          ? renderMarkdown(report)
          : renderText(report, { verbose: opts.verbose });
    process.stdout.write(`${out}\n`);
    if (opts.failOn !== "never") {
      const limit = ORDER[opts.failOn as Severity];
      const worst = [...report.statements.flatMap((s) => s.findings), ...report.notes].some(
        (f) => ORDER[f.severity] <= limit,
      );
      if (worst) process.exitCode = 1;
    }
  });

program.parseAsync().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(
    pc.red(
      /ECONNREFUSED|ENOTFOUND|password authentication/i.test(msg)
        ? `Could not connect to the database: ${msg}`
        : msg,
    ),
  );
  process.exit(2);
});
