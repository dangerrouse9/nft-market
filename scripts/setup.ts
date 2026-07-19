/**
 * One-time environment setup:
 *   1. Creates .env from .env.example if missing
 *   2. Generates creator / buyer / marketplace keypairs in .keys/
 *      and a deployer keypair at ~/.config/solana/id.json
 *   3. Requests devnet SOL for the wallets that need it
 *   4. Prints a summary and the next steps
 *
 * Run: npm run setup
 */
import { Connection } from '@solana/web3.js';
import os from 'node:os';
import path from 'node:path';
import { envStr, loadEnv } from '@agent-nft/shared';
import { airdropIfNeeded, ensureEnvFile, loadOrCreateKeypair, updateEnvVar } from './lib';

async function main() {
  const rootDir = process.cwd();
  ensureEnvFile(rootDir);
  loadEnv();

  const rpcUrl = envStr('SOLANA_RPC_URL', 'https://api.devnet.solana.com');
  const keysDir = path.join(rootDir, envStr('KEYS_DIR', '.keys'));
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log(`\nNetwork: ${envStr('SOLANA_NETWORK', 'devnet')} (${rpcUrl})\n`);

  // --- Wallets ---------------------------------------------------------
  const wallets = {
    creator: loadOrCreateKeypair(path.join(keysDir, 'creator.json')),
    buyer: loadOrCreateKeypair(path.join(keysDir, 'buyer.json')),
    marketplace: loadOrCreateKeypair(path.join(keysDir, 'marketplace.json')),
    deployer: loadOrCreateKeypair(path.join(os.homedir(), '.config', 'solana', 'id.json')),
  };
  for (const [name, { keypair, created }] of Object.entries(wallets)) {
    console.log(`✓ ${name} wallet: ${keypair.publicKey.toBase58()} ${created ? '(new)' : ''}`);
  }

  updateEnvVar(rootDir, 'MARKETPLACE_WALLET_ADDRESS', wallets.marketplace.keypair.publicKey.toBase58());
  console.log('✓ MARKETPLACE_WALLET_ADDRESS written to .env');

  // --- Funding ---------------------------------------------------------
  console.log('\nRequesting devnet SOL (faucet is rate-limited, this may take a moment)...');
  await airdropIfNeeded(connection, wallets.creator.keypair.publicKey, 'creator');
  await airdropIfNeeded(connection, wallets.buyer.keypair.publicKey, 'buyer');
  // Deploying the program costs ~2-4 SOL in rent; top the deployer higher.
  await airdropIfNeeded(connection, wallets.deployer.keypair.publicKey, 'deployer', 3, 5);

  // --- Env sanity ------------------------------------------------------
  console.log('');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('! ANTHROPIC_API_KEY is empty in .env — the agents need it to run.');
    console.warn('  Get one at https://console.anthropic.com -> API Keys');
  } else {
    console.log('✓ ANTHROPIC_API_KEY present');
  }

  console.log(`
Next steps:
  1. npm run register-agents        # register both agents on the Metaplex registry
  2. cd packages/contracts && anchor build && anchor keys sync && anchor build
  3. cp packages/contracts/target/idl/agent_marketplace.json packages/shared/idl/
  4. anchor deploy --provider.cluster devnet   (from packages/contracts)
  5. set MARKETPLACE_PROGRAM_ID in .env to the deployed program id
  6. npm run init-config            # store fee + fee wallet on-chain
  7. npm run api                    # start the marketplace API
  8. npm run creator                # start minting
  9. npm run buyer                  # start buying
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
