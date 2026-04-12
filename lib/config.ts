/**
 * Project configuration loader.
 *
 * Reads config.json from project root. All tools should use this
 * instead of hardcoding IPs or credentials.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const configPath = resolve(ROOT, "config.json");

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

export interface Config {
  processors: Record<string, ProcessorConfig>;
  openBridge: string;
  designer: DesignerConfig;
}

function loadConfig(): Config {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing config.json — copy config.example.json to config.json and fill in your values`,
    );
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
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
