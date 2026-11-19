import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

/** The Office Durable Object, run in workerd with the real D1 migrations; everything else is tested in Node (vitest.config.ts). */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  return {
    test: {
      include: ["test/do/**/*.test.ts"],
      setupFiles: ["./test/do/setup.ts"],
      poolOptions: {
        workers: {
          main: "./test/do/worker.ts",
          singleWorker: true,
          // WebSockets to a Durable Object do not survive per-test storage isolation; each test opens its own office instead.
          isolatedStorage: false,
          miniflare: {
            compatibilityDate: "2025-04-01",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: { Office: { className: "Office", useSQLite: true } },
            d1Databases: ["DB"],
            r2Buckets: ["DOCS"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              DATA_MODE: "test",
              MAIL_FROM: "office@the-office.test",
              INGEST_DOMAIN: "in.the-office.test",
              BETTER_AUTH_URL: "http://localhost:8787",
              BETTER_AUTH_SECRET: "office-do-test-secret-not-a-real-one",
              SOCIAL_TOKEN_KEY: "office-do-test-secret-not-a-real-one",
              X_CLIENT_ID: "x-client-for-tests",
              X_CLIENT_SECRET: "x-secret-for-tests",
            },
          },
        },
      },
    },
  };
});
