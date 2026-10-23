import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Migration, Project } from "./types.js";

const read = (f: string) => readFileSync(f, "utf8");

/** Prisma: <schema dir>/migrations/<timestamp_name>/migration.sql */
function prismaMigrationsDir(root: string): string | undefined {
  const candidates = [join(root, "prisma", "migrations"), join(root, "migrations")];
  // package.json "prisma": { "schema": "db/schema.prisma" }
  try {
    const pkg = JSON.parse(read(join(root, "package.json")));
    if (typeof pkg?.prisma?.schema === "string")
      candidates.unshift(join(root, dirname(pkg.prisma.schema), "migrations"));
  } catch {}
  return candidates.find((d) => existsSync(d) && existsSync(join(d, "migration_lock.toml")));
}

function prisma(dir: string, root: string): Project {
  const migrations: Migration[] = readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "migration.sql")))
    .sort()
    .map((d) => ({
      name: d,
      file: join(dir, d, "migration.sql"),
      sql: read(join(dir, d, "migration.sql")),
    }));
  return { tool: "prisma", root, migrations, transaction: "per-file-if-multiple" };
}

const DRIZZLE_CONFIGS = [
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "drizzle.config.cjs",
  "drizzle.config.json",
];

function drizzle(root: string): Project | undefined {
  const config = DRIZZLE_CONFIGS.map((f) => join(root, f)).find(existsSync);
  const text = config ? read(config) : "";
  const out =
    /\bout\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1] ?? /"out"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const dir = resolve(root, out ?? "drizzle");
  const journalFile = join(dir, "meta", "_journal.json");
  if (!existsSync(journalFile))
    return config
      ? { tool: "drizzle", root, migrations: [], transaction: "all-pending" }
      : undefined;
  const journal = JSON.parse(read(journalFile)) as {
    entries?: Array<{ idx: number; when: number; tag: string }>;
  };
  const migrations: Migration[] = (journal.entries ?? [])
    .sort((a, b) => a.idx - b.idx)
    .filter((e) => existsSync(join(dir, `${e.tag}.sql`)))
    .map((e) => ({
      name: e.tag,
      file: join(dir, `${e.tag}.sql`),
      sql: read(join(dir, `${e.tag}.sql`)),
      when: e.when,
    }));
  const migrationsBlock = /migrations\s*:\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  return {
    tool: "drizzle",
    root,
    migrations,
    transaction: "all-pending",
    drizzleMigrationsTable: {
      schema: /schema\s*:\s*["'`]([^"'`]+)["'`]/.exec(migrationsBlock)?.[1] ?? "drizzle",
      table: /table\s*:\s*["'`]([^"'`]+)["'`]/.exec(migrationsBlock)?.[1] ?? "__drizzle_migrations",
    },
  };
}

function sqlFiles(paths: string[], root: string): Project {
  const files = paths.flatMap((p) => {
    const abs = resolve(root, p);
    if (!existsSync(abs)) throw new Error(`No such file or directory: ${p}`);
    if (statSync(abs).isDirectory())
      return readdirSync(abs)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => join(abs, f));
    return [abs];
  });
  return {
    tool: "sql",
    root,
    migrations: files.map((f) => ({ name: basename(f), file: f, sql: read(f) })),
    transaction: "none",
  };
}

/**
 * Find migrations. Explicit paths win; inside a Prisma folder or a Drizzle out dir they keep
 * that tool's semantics.
 */
export function discover(root: string, paths: string[] = []): Project {
  if (paths.length) {
    const abs = paths.map((p) => resolve(root, p));
    const prismaDir = prismaMigrationsDir(root);
    if (prismaDir && abs.every((p) => p.startsWith(prismaDir))) {
      const all = prisma(prismaDir, root);
      const wanted = new Set(abs.map((p) => (p.endsWith(".sql") ? dirname(p) : p)));
      const picked = all.migrations.filter(
        (m) => wanted.has(dirname(m.file)) || wanted.has(prismaDir),
      );
      if (picked.length) return { ...all, migrations: picked };
    }
    return sqlFiles(paths, root);
  }
  const prismaDir = prismaMigrationsDir(root);
  if (prismaDir) return prisma(prismaDir, root);
  const d = drizzle(root);
  if (d) return d;
  throw new Error(
    "No migrations found. Run inside a Prisma or Drizzle project, or pass .sql files/directories.",
  );
}
