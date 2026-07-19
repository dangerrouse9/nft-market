import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '@agent-nft/shared';

/** Sets KEY=value in the root .env, replacing an existing line or appending. */
export function updateEnvVar(rootDir: string, key: string, value: string): void {
  const envPath = path.join(rootDir, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envPath, content);
  process.env[key] = value;
}

export function ensureEnvFile(rootDir: string): void {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.join(rootDir, '.env.example'), envPath);
    console.log('✓ Created .env from .env.example');
  }
}

export function loadOrCreateKeypair(filePath: string): { keypair: Keypair; created: boolean } {
  if (fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as number[];
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(raw)), created: false };
  }
  const keypair = Keypair.generate();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, created: true };
}

export async function airdropIfNeeded(
  connection: Connection,
  pubkey: PublicKey,
  label: string,
  minSOL = 1,
  requestSOL = 2,
): Promise<boolean> {
  const balance = (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
  if (balance >= minSOL) {
    console.log(`✓ ${label}: ${balance.toFixed(3)} SOL (no airdrop needed)`);
    return true;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  ${label}: requesting ${requestSOL} SOL from faucet (attempt ${attempt})...`);
      const sig = await connection.requestAirdrop(pubkey, requestSOL * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      const after = (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
      console.log(`✓ ${label} funded: ${after.toFixed(3)} SOL`);
      return true;
    } catch (err: any) {
      console.warn(`  faucet attempt ${attempt} failed: ${err.message?.slice(0, 100)}`);
      await sleep(3_000 * attempt);
    }
  }
  console.warn(
    `✗ ${label}: faucet rate-limited. Fund ${pubkey.toBase58()} manually at https://faucet.solana.com`,
  );
  return false;
}
