/**
 * Environment variable loader for Lutron tools.
 *
 * Reads from .env file in project root. All tools should use these
 * instead of hardcoding IPs, credentials, or network parameters.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const envPath = resolve(ROOT, ".env");

// Load .env file into process.env (only if not already set)
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

export const RA3_HOST = process.env.RA3_HOST ?? "10.0.0.1";
export const CASETA_HOST = process.env.CASETA_HOST ?? "10.0.0.2";
export const NUCLEO_HOST = process.env.NUCLEO_HOST ?? "10.0.0.3";
export const DESIGNER_VM_HOST = process.env.DESIGNER_VM_HOST ?? "10.0.0.4";
export const DESIGNER_VM_USER = process.env.DESIGNER_VM_USER ?? "user";
export const DESIGNER_VM_PASS = process.env.DESIGNER_VM_PASS ?? "pass";

export const THREAD_CHANNEL = parseInt(process.env.THREAD_CHANNEL ?? "25", 10);
export const THREAD_PANID = parseInt(process.env.THREAD_PANID ?? "0", 16);
export const THREAD_XPANID = process.env.THREAD_XPANID ?? "0000000000000000";
export const THREAD_MASTER_KEY =
  process.env.THREAD_MASTER_KEY ?? "00000000000000000000000000000000";
