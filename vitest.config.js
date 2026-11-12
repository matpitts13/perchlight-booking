import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        // The test Worker exports the Clock built around the tests' config.
        main: "./test/worker.js",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token-0123456789",
            IP_SALT: "test-ip-salt-0123456789",
            LINK_SECRET: "test-link-secret-0123456789",
            FEED_SECRET: "test-feed-secret-0123456789",
            TURNSTILE_SECRET_KEY: "test-turnstile-secret",
            TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
            MAIL_FROM: "Bookings <bookings@example.com>",
            FALLBACK_CONTACT: "help@example.com",
            PUBLIC_URL: "https://booking.test",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      include: ["test/**/*.test.js"],
    },
  };
});