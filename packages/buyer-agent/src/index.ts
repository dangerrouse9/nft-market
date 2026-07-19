import { PublicKey } from '@solana/web3.js';
import {
  MarketplaceClient,
  explorerUrl,
  loadAgentKeypair,
  shortAddress,
  sleep,
  type Listing,
} from '@agent-nft/shared';
import { cfg } from './config';
import { evaluateListing } from './evaluate';
import { loadState, saveState } from './state';

const keypair = loadAgentKeypair('buyer');
const state = loadState();

async function fetchListings(): Promise<Listing[]> {
  const response = await fetch(`${cfg.marketplaceUrl}/listings`);
  if (!response.ok) throw new Error(`Marketplace API error ${response.status}`);
  return (await response.json()) as Listing[];
}

async function syncListing(tokenId: string): Promise<void> {
  // The API never takes "sold" on trust — this just asks it to re-check the
  // chain immediately instead of waiting for its next reconcile pass.
  const response = await fetch(`${cfg.marketplaceUrl}/listings/${tokenId}/sync`, {
    method: 'POST',
  });
  if (!response.ok) {
    console.warn(`[buyer] sync for ${shortAddress(tokenId)} returned ${response.status}`);
  }
}

async function purchase(client: MarketplaceClient, listing: Listing): Promise<void> {
  const signature = await client.buy(
    new PublicKey(listing.tokenId),
    new PublicKey(cfg.buyerAgentAsset()),
  );
  state.spentSOL += listing.priceSOL;
  state.purchases.push({
    tokenId: listing.tokenId,
    priceSOL: listing.priceSOL,
    signature,
    at: new Date().toISOString(),
  });
  saveState(state);
  await syncListing(listing.tokenId);
  console.log(`[buyer] PURCHASED ${shortAddress(listing.tokenId)} for ${listing.priceSOL} SOL`);
  console.log(`[buyer] ${explorerUrl(signature, cfg.network)}`);
}

async function pollOnce(client: MarketplaceClient): Promise<void> {
  const listings = await fetchListings();
  console.log(`[buyer] ${listings.length} active listing(s), spent ${state.spentSOL.toFixed(4)}/${cfg.budgetSOL} SOL`);

  for (const listing of listings) {
    if (state.spentSOL + listing.priceSOL > cfg.budgetSOL) continue;
    if (listing.sellerAddress === keypair.publicKey.toBase58()) continue;
    if (state.evaluated[listing.tokenId]) continue;

    let decision: 'buy' | 'pass';
    try {
      const evaluation = await evaluateListing(listing);
      decision = evaluation.decision;
      console.log(
        `[buyer] [${shortAddress(listing.tokenId)}] ${evaluation.decision} ` +
          `(${evaluation.confidence.toFixed(2)}): ${evaluation.reasoning}`,
      );
    } catch (err: any) {
      console.error(`[buyer] evaluation failed: ${err.message}`);
      continue;
    }

    state.evaluated[listing.tokenId] = decision;
    saveState(state);

    if (decision === 'buy' && listing.priceSOL <= cfg.maxPricePerNFT) {
      try {
        await purchase(client, listing);
      } catch (err: any) {
        console.error(`[buyer] purchase failed: ${err.message}`);
        // Allow retry on a later poll
        delete state.evaluated[listing.tokenId];
        saveState(state);
      }
    }

    await sleep(2_000); // rate limit between evaluations
  }
}

async function main() {
  console.log('[buyer] agent starting');
  console.log(`[buyer] wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`[buyer] budget ${cfg.budgetSOL} SOL, max ${cfg.maxPricePerNFT} SOL/piece`);

  const client = new MarketplaceClient(cfg.rpcUrl, keypair, cfg.programId());

  while (true) {
    if (state.spentSOL >= cfg.budgetSOL) {
      console.log('[buyer] budget exhausted — stopping');
      return;
    }
    try {
      await pollOnce(client);
    } catch (err: any) {
      console.error(`[buyer] poll failed: ${err.message}`);
    }
    await sleep(cfg.pollSeconds * 1_000);
  }
}

main();
