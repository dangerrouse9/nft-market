import { PublicKey } from '@solana/web3.js';
import {
  MarketplaceClient,
  explorerUrl,
  loadAgentKeypair,
  solToLamports,
} from '@agent-nft/shared';
import { cfg } from './config';
import { generateContent } from './generate';
import { mintNFT } from './mint';
import { makeUmi } from './umi';
import { loadState, recordMint } from './state';
import { registerListing } from './marketplaceApi';

const keypair = loadAgentKeypair('creator');
const umi = makeUmi(keypair);
let state = loadState();

async function runCycle(): Promise<void> {
  console.log(`\n[creator] cycle start ${new Date().toISOString()}`);

  // 1. Generate content with Claude
  const content = await generateContent(
    state.recentPreviews.map((p) => p.slice(0, 100)),
  );
  console.log(`[creator] generated ${content.length} chars: "${content.slice(0, 80)}..."`);

  // 2 + 3. Upload metadata to Irys and mint the Core NFT with royalties
  const mint = await mintNFT(umi, content);
  console.log(`[creator] minted ${mint.assetAddress}`);
  console.log(`[creator] explorer: ${explorerUrl(mint.assetAddress, cfg.network, 'address')}`);

  // 4. List on-chain: escrows the NFT in the marketplace program
  const client = new MarketplaceClient(cfg.rpcUrl, keypair, cfg.programId());
  const listSig = await client.list(
    new PublicKey(mint.assetAddress),
    keypair.publicKey,
    solToLamports(cfg.mintPriceSOL),
    cfg.royaltyBps,
  );
  console.log(`[creator] listed on-chain: ${explorerUrl(listSig, cfg.network)}`);

  // 5. Publish to the marketplace API so buyer agents can discover it
  await registerListing({
    tokenId: mint.assetAddress,
    contentUri: mint.uri,
    contentPreview: content.slice(0, 200),
    priceSOL: cfg.mintPriceSOL,
    creatorAddress: keypair.publicKey.toBase58(),
    sellerAddress: keypair.publicKey.toBase58(),
    sellerAgentAsset: cfg.creatorAgentAsset(),
  });
  console.log('[creator] listing published to marketplace API');

  state = recordMint(state, content.slice(0, 200));
  console.log(`[creator] total minted: ${state.totalMinted}`);
}

async function main() {
  console.log('[creator] agent starting');
  console.log(`[creator] wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`[creator] price ${cfg.mintPriceSOL} SOL, royalty ${cfg.royaltyBps} bps, every ${cfg.mintIntervalMinutes}m`);

  await runCycle().catch((err) => {
    console.error('[creator] cycle failed:', err.message ?? err);
    if (cfg.runOnce) process.exit(1);
  });
  if (cfg.runOnce) return;

  setInterval(() => {
    runCycle().catch((err) => console.error('[creator] cycle failed:', err.message ?? err));
  }, cfg.mintIntervalMinutes * 60_000);
}

main();
