import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { IntentSchema, type Intent } from "./schema.js";

export function loadIntent(path: string): Intent {
  const fullPath = resolve(process.cwd(), path);
  const content = readFileSync(fullPath, "utf-8");
  const raw = parseYaml(content);
  return IntentSchema.parse(raw);
}
