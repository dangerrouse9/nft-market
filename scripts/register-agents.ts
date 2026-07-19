/**
 * Registers the creator and buyer wallets on the Metaplex Agent Registry
 * ("014"). Each registration mints a Core asset that acts as the agent's
 * on-chain identity and creates an AgentIdentity PDA the marketplace
 * contract checks at purchase time.
 *
 * Requires funded wallets (run `npm run setup` first).
 * Run: npm run register-agents
 */
import {
  mintAndSubmitAgent,
  mplAgentIdentity,
} from '@metaplex-foundation/mpl-agent-registry';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import type { Keypair } from '@solana/web3.js';
import {
  envStr,
  explorerUrl,
  loadAgentKeypair,
  loadEnv,
  uploadMetadata,
} from '@agent-nft/shared';
import { updateEnvVar } from './lib';

const rootDir = process.cwd();
loadEnv();
const rpcUrl = envStr('SOLANA_RPC_URL', 'https://api.devnet.solana.com');
const network = envStr('SOLANA_NETWORK', 'devnet');
const marketplaceUrl = envStr('MARKETPLACE_URL', 'http://localhost:3000');

function makeUmi(keypair: Keypair) {
  const umi = createUmi(rpcUrl)
    .use(mplAgentIdentity())
    .use(
      irysUploader(network === 'devnet' ? { address: 'https://devnet.irys.xyz' } : {}),
    );
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(keypair.secretKey)));
  return umi;
}

async function registerAgent(
  name: string,
  description: string,
  keypairName: string,
  envVar: string,
  services: { name: string; endpoint: string }[],
): Promise<void> {
  if (process.env[envVar]) {
    console.log(`✓ ${name} already registered: ${process.env[envVar]} (skipping)`);
    return;
  }
  const keypair = loadAgentKeypair(keypairName);
  const umi = makeUmi(keypair);

  console.log(`Registering "${name}" (wallet ${keypair.publicKey.toBase58()})...`);

  const metadata = {
    name,
    description,
    type: 'agent',
    created_at: new Date().toISOString(),
  };
  const { uri, via } = await uploadMetadata(metadata, {
    irysUpload: () => umi.uploader.uploadJson(metadata),
    marketplaceUrl,
  });
  console.log(`  metadata uploaded via ${via}: ${uri}`);

  const result = await mintAndSubmitAgent(
    umi,
    {},
    {
      wallet: umi.identity.publicKey,
      network: network === 'mainnet-beta' ? 'solana-mainnet' : 'solana-devnet',
      name,
      uri,
      agentMetadata: {
        type: 'agent',
        name,
        description,
        services,
        registrations: [],
        supportedTrust: [],
      },
    },
  );

  const assetAddress = result.assetAddress.toString();
  const signature = base58.deserialize(result.signature)[0];
  updateEnvVar(rootDir, envVar, assetAddress);
  console.log(`✓ ${name} registered`);
  console.log(`  agent asset: ${assetAddress}`);
  console.log(`  explorer:    ${explorerUrl(assetAddress, network, 'address')}`);
  console.log(`  tx:          ${explorerUrl(signature, network)}`);
}

async function main() {
  await registerAgent(
    'agent-nft Creator',
    'Autonomous AI artist minting original Claude-generated works as Metaplex Core NFTs and listing them for sale to other agents.',
    'creator',
    'CREATOR_AGENT_ASSET_ADDRESS',
    [{ name: 'marketplace-listings', endpoint: `${marketplaceUrl}/listings` }],
  );
  await registerAgent(
    'agent-nft Collector',
    'Autonomous collector agent that evaluates NFT listings with Claude and purchases pieces it judges original, within a fixed budget.',
    'buyer',
    'BUYER_AGENT_ASSET_ADDRESS',
    [],
  );
  console.log('\nBoth agents registered. Asset addresses were written to .env.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
