import { PublicKey } from '@solana/web3.js';
import {
  MarketplaceClient,
  explorerUrl,
  isRateLimit,
  loadAgentKeypair,
  retry,
  shortAddress,
  solToLamports,
} from '@agent-nft/shared';
import { cfg } from './config';
import { generateContent } from './generate';
import { mintNFT } from './mint';
import { makeUmi } from './umi';
import { addPending, loadState, recordMint, removePending, type PendingListing } from './state';
import { registerListing } from './marketplaceApi';

const keypair = loadAgentKeypair('creator');
const umi = makeUmi(keypair);
const client = new MarketplaceClient(cfg.rpcUrl, keypair, cfg.programId());
const state = loadState();

/**
 * Publishes any escrowed-but-unpublished listings. This is the safety net:
 * an asset is added to the pending queue the moment it is escrowed on-chain,
 * so even if publishing failed (or the process restarted), the next cycle
 * finishes the job — nothing minted is ever stranded in escrow unlisted.
 */
async function flushPending(): Promise<void> {
  if (state.pending.length === 0) return;
  console.log(`[creator] flushing ${state.pending.length} pending listing(s)`);
  for (const listing of [...state.pending]) {
    try {
      await registerListing(listing);
      removePending(state, listing.tokenId);
      console.log(`[creator] recovered pending listing ${shortAddress(listing.tokenId)}`);
    } catch (err: any) {
      console.warn(`[creator] pending ${shortAddress(listing.tokenId)} still failing: ${err.message}`);
    }
  }
}

async function runCycle(): Promise<void> {
  console.log(`\n[creator] cycle start ${new Date().toISOString()}`);

  // 0. Recover anything escrowed but not yet published (from prior cycles).
  await flushPending();

  // 1. Generate content with Claude
  const content = await generateContent(state.recentPreviews.map((p) => p.slice(0, 100)));
  console.log(`[creator] generated ${content.length} chars: "${content.slice(0, 80)}..."`);

  // 2 + 3. Upload metadata to Irys and mint the Core NFT with royalties
  const mint = await mintNFT(umi, content);
  console.log(`[creator] minted ${mint.assetAddress}`);
  console.log(`[creator] explorer: ${explorerUrl(mint.assetAddress, cfg.network, 'address')}`);

  // 4. List on-chain: escrows the NFT. Retry through RPC 429s and the
  //    mint→list propagation race (InvalidAssetData) — the freshly minted
  //    asset can take a moment to be readable on a lagging RPC node.
  const listSig = await retry(
    () =>
      client.list(
        new PublicKey(mint.assetAddress),
        keypair.publicKey,
        solToLamports(cfg.mintPriceSOL),
        cfg.royaltyBps,
      ),
    {
      attempts: 5,
      baseMs: 2_000,
      retryable: (err) => isRateLimit(err) || /InvalidAssetData|not a valid Core asset/i.test(
        err instanceof Error ? err.message : String(err),
      ),
      onRetry: (_e, n, d) => console.warn(`[creator] list retry ${n} in ${Math.round(d / 1000)}s`),
    },
  );
  console.log(`[creator] listed on-chain: ${explorerUrl(listSig, cfg.network)}`);

  // 5. Record as pending BEFORE publishing, so the asset is tracked the instant
  //    it is escrowed — then publish (with its own retry). Clear on success.
  const listing: PendingListing = {
    tokenId: mint.assetAddress,
    contentUri: mint.uri,
    contentPreview: content.slice(0, 200),
    priceSOL: cfg.mintPriceSOL,
    creatorAddress: keypair.publicKey.toBase58(),
    sellerAddress: keypair.publicKey.toBase58(),
    sellerAgentAsset: cfg.creatorAgentAsset(),
  };
  addPending(state, listing);
  recordMint(state, content.slice(0, 200));

  await registerListing(listing);
  removePending(state, listing.tokenId);
  console.log(`[creator] listing published to marketplace API`);
  console.log(`[creator] total minted: ${state.totalMinted}`);
}

async function main() {
  console.log('[creator] agent starting');
  console.log(`[creator] wallet: ${keypair.publicKey.toBase58()}`);
  console.log(
    `[creator] price ${cfg.mintPriceSOL} SOL, royalty ${cfg.royaltyBps} bps, every ${cfg.mintIntervalMinutes}m`,
  );

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
