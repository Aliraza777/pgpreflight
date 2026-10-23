import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url: "postgres://postgres@localhost:54329/drizzlereal" },
  migrations: { table: "my_migrations", schema: "public" },
});
