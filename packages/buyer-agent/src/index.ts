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

/** Reason a poll stopped early; drives how long the agent then idles. */
type PollResult = 'ok' | 'broke' | 'capped' | 'claude-down' | 'budget';

let evalCount = 0; // Claude evaluations this process — capped as a circuit breaker

function isInsufficientFunds(msg: string): boolean {
  return /insufficient|0x1\b|debit an account|attempt to debit/i.test(msg);
}
function isClaudeUnavailable(msg: string): boolean {
  return /credit balance|quota|billing|insufficient_quota|rate limit|429/i.test(msg);
}

async function walletSOL(client: MarketplaceClient): Promise<number> {
  const lamports = await client.connection.getBalance(keypair.publicKey);
  return lamports / 1_000_000_000;
}

async function fetchListings(): Promise<Listing[]> {
  const response = await fetch(`${cfg.marketplaceUrl}/listings`);
  if (!response.ok) throw new Error(`Marketplace API error ${response.status}`);
  return (await response.json()) as Listing[];
}

async function syncListing(tokenId: string): Promise<void> {
  const response = await fetch(`${cfg.marketplaceUrl}/listings/${tokenId}/sync`, { method: 'POST' });
  if (!response.ok) console.warn(`[buyer] sync for ${shortAddress(tokenId)} returned ${response.status}`);
}

/** Executes a purchase on-chain (no Claude call). Returns true on success. */
async function purchase(client: MarketplaceClient, listing: Listing): Promise<boolean> {
  try {
    const signature = await client.buy(
      new PublicKey(listing.tokenId),
      new PublicKey(cfg.buyerAgentAsset()),
    );
    state.spentSOL += listing.priceSOL;
    state.purchases.push({ tokenId: listing.tokenId, priceSOL: listing.priceSOL, signature, at: new Date().toISOString() });
    state.pendingBuys = state.pendingBuys.filter((t) => t !== listing.tokenId);
    saveState(state);
    await syncListing(listing.tokenId);
    console.log(`[buyer] PURCHASED ${shortAddress(listing.tokenId)} for ${listing.priceSOL} SOL`);
    console.log(`[buyer] ${explorerUrl(signature, cfg.network)}`);
    return true;
  } catch (err: any) {
    if (isInsufficientFunds(err.message ?? '')) throw err; // bubble up to halt the poll
    // Transient on-chain failure (RPC, contention): keep it in pendingBuys and
    // retry NEXT poll on-chain — critically, we never re-call Claude for it.
    console.error(`[buyer] purchase failed (will retry on-chain): ${err.message}`);
    return false;
  }
}

async function pollOnce(client: MarketplaceClient): Promise<PollResult> {
  // Real-money circuit breaker: if the wallet can't afford a single piece,
  // do not evaluate anything (zero Claude calls) — just idle.
  const balance = await walletSOL(client);
  if (balance < cfg.maxPricePerNFT) {
    console.log(`[buyer] wallet ${balance.toFixed(4)} SOL < ${cfg.maxPricePerNFT} — idling, no evaluations`);
    return 'broke';
  }

  const listings = await fetchListings();
  const active = new Set(listings.map((l) => l.tokenId));
  console.log(`[buyer] ${listings.length} listing(s), spent ${state.spentSOL.toFixed(4)}/${cfg.budgetSOL} SOL, wallet ${balance.toFixed(3)}, evals ${evalCount}/${cfg.maxEvalsPerRun}`);

  // 1. Retry previously-decided buys ON-CHAIN ONLY (no Claude). Drop any that
  //    are no longer listed (someone else bought them / delisted).
  state.pendingBuys = state.pendingBuys.filter((t) => active.has(t));
  for (const tokenId of [...state.pendingBuys]) {
    if (state.spentSOL + cfg.maxPricePerNFT > cfg.budgetSOL) return 'budget';
    const listing = listings.find((l) => l.tokenId === tokenId);
    if (!listing) continue;
    try {
      await purchase(client, listing);
    } catch (err: any) {
      if (isInsufficientFunds(err.message ?? '')) {
        console.warn('[buyer] insufficient funds — halting purchases until wallet is funded');
        return 'broke';
      }
    }
    await sleep(1_000);
  }

  // 2. Evaluate NEW listings (never seen before) — at most once each, ever.
  for (const listing of listings) {
    if (state.spentSOL + listing.priceSOL > cfg.budgetSOL) return 'budget';
    if (listing.sellerAddress === keypair.publicKey.toBase58()) continue;
    if (listing.tokenId in state.evaluated) continue; // permanent cache — never re-evaluate
    if (evalCount >= cfg.maxEvalsPerRun) {
      console.warn(`[buyer] evaluation cap (${cfg.maxEvalsPerRun}) reached — idling`);
      return 'capped';
    }

    let decision: 'buy' | 'pass';
    try {
      const evaluation = await evaluateListing(listing);
      evalCount += 1;
      decision = evaluation.decision;
      console.log(`[buyer] [${shortAddress(listing.tokenId)}] ${decision} (${evaluation.confidence.toFixed(2)}): ${evaluation.reasoning}`);
    } catch (err: any) {
      const msg = err.message ?? String(err);
      if (isClaudeUnavailable(msg)) {
        console.error(`[buyer] Claude unavailable (${msg.slice(0, 80)}) — backing off, not retrying in a tight loop`);
        return 'claude-down';
      }
      console.error(`[buyer] evaluation failed: ${msg}`);
      continue;
    }

    state.evaluated[listing.tokenId] = decision;
    saveState(state);

    if (decision === 'buy' && listing.priceSOL <= cfg.maxPricePerNFT) {
      if (!state.pendingBuys.includes(listing.tokenId)) state.pendingBuys.push(listing.tokenId);
      saveState(state);
      try {
        await purchase(client, listing);
      } catch (err: any) {
        if (isInsufficientFunds(err.message ?? '')) {
          console.warn('[buyer] insufficient funds — halting purchases until wallet is funded');
          return 'broke';
        }
      }
    }
    await sleep(2_000);
  }
  return 'ok';
}

async function main() {
  console.log('[buyer] agent starting');
  console.log(`[buyer] wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`[buyer] budget ${cfg.budgetSOL} SOL, max ${cfg.maxPricePerNFT}/piece, eval cap ${cfg.maxEvalsPerRun}`);

  const client = new MarketplaceClient(cfg.rpcUrl, keypair, cfg.programId());

  while (true) {
    let result: PollResult = 'ok';
    try {
      result = await pollOnce(client);
    } catch (err: any) {
      console.error(`[buyer] poll failed: ${err.message}`);
    }

    // Any non-ok result (budget exhausted, empty wallet, eval cap, Claude
    // unavailable) idles for a long stretch instead of looping — no tight
    // loop can ever burn API credits or spam the RPC. Idling (not exiting)
    // means a raised budget / funded wallet resumes on the next redeploy.
    const idleSeconds = result === 'ok' ? cfg.pollSeconds : cfg.dormantMinutes * 60;
    if (result !== 'ok') console.log(`[buyer] dormant (${result}) for ${cfg.dormantMinutes}m`);
    await sleep(idleSeconds * 1_000);
  }
}

main();
