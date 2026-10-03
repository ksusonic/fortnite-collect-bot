import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseConfig } from "../src/bot/storage";
import { SUPABASE_ROOT_CA } from "../src/bot/supabase-ca";

afterEach(() => vi.unstubAllEnvs());
describe("database TLS configuration", () => {
  it("trusts the official Supabase CA without weakening TLS verification", () => {
    vi.stubEnv("DATABASE_LOCAL_TEST", "0");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://test:test@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=no-verify&sslrootcert=untrusted",
    );
    const config = databaseConfig();
    expect(config.ssl).toMatchObject({
      rejectUnauthorized: true,
      ca: expect.arrayContaining([SUPABASE_ROOT_CA]),
    });
    expect(new URL(config.connectionString).search).toBe("");
    const certificate = new X509Certificate(SUPABASE_ROOT_CA);
    expect(certificate.ca).toBe(true);
    expect(certificate.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
    );
  });
  it("does not extend trust for other database hosts", () => {
    vi.stubEnv("DATABASE_LOCAL_TEST", "0");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://test:test@pooler.supabase.com.attacker.example:5432/postgres",
    );
    expect(databaseConfig().ssl).toEqual({ rejectUnauthorized: true });
  });
  it("allows plaintext only for an explicitly local test database", () => {
    vi.stubEnv("DATABASE_LOCAL_TEST", "1");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://test:test@localhost:5432/fortnite_test",
    );
    expect(databaseConfig().ssl).toBe(false);
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://test:test@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
    );
    expect(() => databaseConfig()).toThrow("restricted to localhost");
  });
});
