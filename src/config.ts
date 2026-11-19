import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const EnvSchema = z
  .object({
    BANK_API_BASE_URL: z.url({ message: "BANK_API_BASE_URL must be a URL, e.g. http://localhost:8080" }),
    BANK_API_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
    BANK_EMAIL: z.preprocess(emptyToUndefined, z.string().optional()),
    BANK_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
    BANK_API_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(5000)),
    BANK_API_MAX_RETRIES: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(5).default(2)),
    LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["debug", "info", "warn", "error"]).default("info")),
  })
  .refine((e) => e.BANK_API_TOKEN || (e.BANK_EMAIL && e.BANK_PASSWORD), {
    message: "Set BANK_API_TOKEN, or both BANK_EMAIL and BANK_PASSWORD",
  });

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  baseUrl: string;
  token?: string;
  credentials?: { email: string; password: string };
  timeoutMs: number;
  /** Retries for read requests after a network failure, timeout, 429 or 5xx. Writes are never retried. */
  maxRetries: number;
  logLevel: LogLevel;
}

/** Parses environment variables into a Config. Throws with a readable message when invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  const e = parsed.data;
  return {
    baseUrl: e.BANK_API_BASE_URL.replace(/\/+$/, ""),
    token: e.BANK_API_TOKEN,
    credentials: e.BANK_EMAIL && e.BANK_PASSWORD ? { email: e.BANK_EMAIL, password: e.BANK_PASSWORD } : undefined,
    timeoutMs: e.BANK_API_TIMEOUT_MS,
    maxRetries: e.BANK_API_MAX_RETRIES,
    logLevel: e.LOG_LEVEL,
  };
}
