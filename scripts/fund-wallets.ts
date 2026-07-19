/**
 * Tops up the agent wallets and the deployer from the devnet faucet
 * when balances run low. Run: npm run fund-wallets
 */
import { Connection } from '@solana/web3.js';
import os from 'node:os';
import path from 'node:path';
import { envStr, loadEnv, loadKeypairFile } from '@agent-nft/shared';
import { airdropIfNeeded } from './lib';

async function main() {
  const rootDir = loadEnv();
  const rpcUrl = envStr('SOLANA_RPC_URL', 'https://api.devnet.solana.com');
  const keysDir = path.join(rootDir, envStr('KEYS_DIR', '.keys'));
  const connection = new Connection(rpcUrl, 'confirmed');

  const targets = [
    ['creator', path.join(keysDir, 'creator.json')],
    ['buyer', path.join(keysDir, 'buyer.json')],
    ['deployer', path.join(os.homedir(), '.config', 'solana', 'id.json')],
  ] as const;

  for (const [label, file] of targets) {
    try {
      const keypair = loadKeypairFile(file);
      await airdropIfNeeded(connection, keypair.publicKey, label);
    } catch {
      console.warn(`- ${label}: no keypair at ${file} (run npm run setup)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
