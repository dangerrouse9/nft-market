/**
 * Initializes the on-chain marketplace config (fee bps + fee wallet).
 * Run once after `anchor deploy`, with MARKETPLACE_PROGRAM_ID set in .env:
 *   npm run init-config
 */
import { PublicKey } from '@solana/web3.js';
import os from 'node:os';
import path from 'node:path';
import {
  MarketplaceClient,
  envNum,
  envStr,
  explorerUrl,
  loadEnv,
  loadKeypairFile,
  requireEnv,
} from '@agent-nft/shared';

async function main() {
  loadEnv();
  const rpcUrl = envStr('SOLANA_RPC_URL', 'https://api.devnet.solana.com');
  const network = envStr('SOLANA_NETWORK', 'devnet');
  const programId = requireEnv('MARKETPLACE_PROGRAM_ID');
  const marketplaceWallet = new PublicKey(requireEnv('MARKETPLACE_WALLET_ADDRESS'));
  const feeBps = envNum('MARKETPLACE_FEE_BPS', 150);

  const deployer = loadKeypairFile(
    path.join(os.homedir(), '.config', 'solana', 'id.json'),
  );
  const client = new MarketplaceClient(rpcUrl, deployer, programId);

  try {
    const existing = await client.fetchConfig();
    console.log('Config already initialized:');
    console.log(`  marketplace wallet: ${existing.marketplaceWallet.toString()}`);
    console.log(`  fee: ${existing.feeBps} bps`);
    return;
  } catch {
    // not initialized yet
  }

  const sig = await client.initializeConfig(marketplaceWallet, feeBps);
  console.log(`✓ Config initialized: fee ${feeBps} bps -> ${marketplaceWallet.toBase58()}`);
  console.log(`  ${explorerUrl(sig, network)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
