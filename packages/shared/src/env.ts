import * as dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

let cachedRoot: string | null = null;

/**
 * Loads the nearest .env walking up from cwd (repo root in local dev).
 * On Railway there is no .env file — variables come from the dashboard —
 * so a missing file is fine. Returns the directory used to resolve
 * relative paths like KEYS_DIR and DATA_DIR.
 */
export function loadEnv(): string {
  if (cachedRoot) return cachedRoot;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function envStr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} is not a number: ${raw}`);
  }
  return parsed;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === 'true' || raw === '1';
}

/** Resolves a possibly-relative path against the repo root found by loadEnv(). */
export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(loadEnv(), p);
}
