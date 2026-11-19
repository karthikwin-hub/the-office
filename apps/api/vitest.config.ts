import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:email": fileURLToPath(new URL("./test/cloudflare-email.ts", import.meta.url)) } },
  // The Office Durable Object's tests run in workerd: vitest.do.config.ts.
  test: { exclude: [...configDefaults.exclude, "test/do/**"] },
});
