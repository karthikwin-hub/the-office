import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The Office Durable Object's tests run in workerd: vitest.do.config.ts.
  test: { setupFiles: ["./test/setup.ts"], exclude: [...configDefaults.exclude, "test/do/**"] },
  resolve: { alias: { "cloudflare:email": fileURLToPath(new URL("./test/cloudflare-email.ts", import.meta.url)) } },
});
