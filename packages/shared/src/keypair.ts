import { Keypair } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { envStr, resolveFromRoot } from './env';

export function loadKeypairFile(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function saveKeypairFile(filePath: string, keypair: Keypair): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), {
    mode: 0o600,
  });
}

/**
 * Loads an agent keypair by name ("creator", "buyer", "marketplace").
 * Order of precedence:
 *   1. `<NAME>_KEYPAIR` env var containing the JSON secret key array
 *      (used on Railway, where there is no filesystem persistence)
 *   2. `<KEYS_DIR>/<name>.json` on disk (local dev)
 */
export function loadAgentKeypair(name: string): Keypair {
  const envVar = `${name.toUpperCase()}_KEYPAIR`;
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv) as number[]));
  }
  const keysDir = resolveFromRoot(envStr('KEYS_DIR', '.keys'));
  const filePath = path.join(keysDir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No keypair for "${name}": set ${envVar} or create ${filePath} (run: npm run setup)`,
    );
  }
  return loadKeypairFile(filePath);
}
