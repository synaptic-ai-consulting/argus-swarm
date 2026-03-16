import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  apiKeyPath: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  repository: z.string().optional(),
  defaultRef: z.string().default("main"),
  maxAgents: z.number().default(5),
  openaiApiKeyPath: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(process.env.HOME || "", p.slice(2));
  }
  return resolve(p);
}

export function loadConfig(): Config {
  const candidates = [
    "argus.config.local.yaml",
    "argus.config.yaml",
  ];

  for (const name of candidates) {
    const path = resolve(process.cwd(), name);
    if (existsSync(path)) {
      const raw = parseYaml(readFileSync(path, "utf-8")) ?? {};
      return ConfigSchema.parse(raw);
    }
  }

  return ConfigSchema.parse({});
}

export function getApiKey(config: Config): string {
  const env = process.env.CURSOR_API_KEY;
  if (env) return env;

  const path = config.apiKeyPath;
  if (path) {
    const fullPath = expandPath(path);
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, "utf-8").trim();
    }
  }

  throw new Error(
    "Cursor API key not found. Set CURSOR_API_KEY or apiKeyPath in argus.config.yaml"
  );
}

const LOCAL_CONFIG_NAME = "argus.config.local.yaml";

export function getConfigPath(): string {
  return resolve(process.cwd(), LOCAL_CONFIG_NAME);
}

export function saveConfig(updates: Partial<Config>): void {
  const path = getConfigPath();
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = (parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>) ?? {};
    } catch {
      // ignore
    }
  }
  const merged = { ...current, ...updates };
  const dir = resolve(process.cwd());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, stringifyYaml(merged), "utf-8");
}
