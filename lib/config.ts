/**
 * Project configuration loader.
 *
 * Reads config.json from project root. All tools should use this
 * instead of hardcoding IPs or credentials.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const examplePath = resolve(ROOT, "config.example.json");

export interface ProcessorConfig {
  cert: string;
  key: string;
  ca: string;
}

export interface DesignerConfig {
  host: string;
  user: string;
  pass: string;
}

export interface HomeAssistantConfig {
  host: string;
}

export interface Config {
  processors: Record<string, ProcessorConfig>;
  openBridge: string;
  designer: DesignerConfig;
  homeassistant?: HomeAssistantConfig;
}

/**
 * Resolve config.json by checking the project root, then the main checkout
 * (when running inside a git worktree, the gitignored config.json typically
 * lives in the main repo only).
 */
function resolveConfigPath(): string | undefined {
  const candidates = [resolve(ROOT, "config.json")];
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["-C", ROOT, "rev-parse", "--git-common-dir"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (gitCommonDir) {
      candidates.push(resolve(ROOT, gitCommonDir, "..", "config.json"));
    }
  } catch {
    // Not a git repo / git unavailable — only the worktree-local path is checked
  }
  return candidates.find((p) => existsSync(p));
}

function loadConfig(): Config {
  const configPath = resolveConfigPath();
  // Fall back to the example so tests and CI don't need a real config.json.
  // Placeholder IPs (10.x.x.x) can never reach production — any actual network
  // call will fail with a clear connection error.
  if (configPath) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  // Warn for interactive tool use, but stay quiet under the test runner so
  // tests and CI don't get noise.
  const underTest =
    process.execArgv.some((a) => a === "--test" || a.startsWith("--test=")) ||
    process.env.NODE_ENV === "test";
  if (!underTest) {
    process.stderr.write(
      "config: using config.example.json (no config.json found) — copy config.example.json → config.json for real values\n",
    );
  }
  return JSON.parse(readFileSync(examplePath, "utf-8"));
}

export const config = loadConfig();

/** All configured processor IPs */
export const processorIPs = Object.keys(config.processors);

/** First configured processor IP (default for tools that take --host) */
export const defaultHost = processorIPs[0];

/** Resolve cert file paths for a processor IP. Returns absolute paths. */
export function certsForHost(
  host: string,
): { cert: string; key: string; ca: string } | undefined {
  const proc = config.processors[host];
  if (!proc?.cert) return undefined;
  return {
    cert: resolve(ROOT, proc.cert),
    key: resolve(ROOT, proc.key),
    ca: resolve(ROOT, proc.ca),
  };
}
