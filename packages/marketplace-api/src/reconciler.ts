import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchAsset } from '@metaplex-foundation/mpl-core';
import { publicKey as umiPk } from '@metaplex-foundation/umi';
import {
  SEED_ESCROW,
  SEED_LISTING,
  isRateLimit,
  shortAddress,
  sleep,
  type Listing,
} from '@agent-nft/shared';
import type { MarketStore } from './store';

/**
 * Derives listing status from the blockchain instead of trusting API callers.
 *
 * For every listing the API thinks is active:
 *   - listing PDA still exists on-chain  -> still for sale
 *   - PDA closed + asset owned by seller -> delisted
 *   - PDA closed + asset owned by other  -> sold to that owner
 *
 * Reads use 'finalized' commitment so a lagging/forked RPC node can't make a
 * still-active listing look closed (which previously mislabeled sales as
 * delists). A status change is re-verified with a second read before it is
 * persisted, and the whole pass is throttled + backs off on 429 so it doesn't
 * saturate a rate-limited endpoint as the listing count grows.
 */
export class Reconciler {
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly throttleMs: number;
  /** Don't reconcile a listing until it's older than the finalization lag. */
  private readonly graceMs: number;

  constructor(
    private readonly store: MarketStore,
    private readonly rpcUrl: string,
    programId: string,
    private readonly log: (msg: string) => void = console.log,
    throttleMs = 250,
    graceSeconds = 120,
  ) {
    this.connection = new Connection(rpcUrl, 'finalized');
    this.programId = new PublicKey(programId);
    this.throttleMs = throttleMs;
    this.graceMs = graceSeconds * 1_000;
  }

  start(intervalSeconds: number): void {
    void this.runAll();
    this.timer = setInterval(() => void this.runAll(), intervalSeconds * 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll(): Promise<void> {
    let listings: Listing[];
    try {
      listings = await this.store.active();
    } catch {
      return;
    }
    let consecutive429 = 0;
    for (const listing of listings) {
      try {
        await this.reconcile(listing.tokenId);
        consecutive429 = 0;
      } catch (err: any) {
        if (isRateLimit(err)) {
          // Endpoint is saturated — stop hammering it and resume next interval.
          consecutive429 += 1;
          if (consecutive429 >= 3) {
            this.log(`[reconciler] backing off — rate limited, resuming next pass`);
            return;
          }
          await sleep(2_000 * consecutive429);
        } else {
          this.log(`[reconciler] ${shortAddress(listing.tokenId)}: ${err.message}`);
        }
      }
      // Space out calls so a growing feed doesn't burst the RPC endpoint.
      await sleep(this.throttleMs);
    }
  }

  /** Reads chain state for one asset. Returns the on-chain-derived status. */
  private async readChainStatus(
    tokenId: string,
  ): Promise<'active' | 'transient' | { owner: string }> {
    const asset = new PublicKey(tokenId);
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_LISTING), asset.toBuffer()],
      this.programId,
    );
    const info = await this.connection.getAccountInfo(listingPda, 'finalized');
    if (info) return 'active'; // still escrowed and for sale

    const umi = createUmi(this.rpcUrl);
    const assetData = await fetchAsset(umi, umiPk(tokenId));
    const owner = assetData.owner.toString();
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_ESCROW), asset.toBuffer()],
      this.programId,
    );
    if (owner === escrowPda.toBase58()) return 'transient'; // mid-transaction, retry later
    return { owner };
  }

  /** Re-derives one listing's status from chain state. Returns the fresh listing. */
  async reconcile(tokenId: string): Promise<Listing | undefined> {
    const listing = await this.store.get(tokenId);
    if (!listing || listing.status !== 'active') return listing;

    // Grace period: a listing enters the feed on 'confirmed', but we read at
    // 'finalized' (which lags ~13s). Reconciling a just-listed piece before its
    // list tx finalizes reads the stale pre-listing state (no PDA yet, asset
    // still with the seller) and would mislabel it "delisted". Skip until it's
    // comfortably older than the finalization lag — a fresh listing can't have
    // been sold or delisted yet anyway.
    if (Date.now() - Date.parse(listing.listedAt) < this.graceMs) return listing;

    const first = await this.readChainStatus(tokenId);
    if (first === 'active' || first === 'transient') return listing;

    // A status change is about to be written. Re-verify with a fresh read so a
    // single stale/false-closed response can't flip a live listing. Both reads
    // must agree on the same new owner before we commit.
    await sleep(1_500);
    const second = await this.readChainStatus(tokenId);
    if (typeof second !== 'object' || second.owner !== first.owner) {
      return listing; // reads disagree -> not settled, leave active and retry next pass
    }
    const owner = second.owner;

    if (owner === listing.sellerAddress) {
      this.log(`[reconciler] ${shortAddress(tokenId)} delisted (returned to seller)`);
      return await this.store.update(tokenId, { status: 'delisted' });
    }

    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_LISTING), new PublicKey(tokenId).toBuffer()],
      this.programId,
    );
    let txSignature: string | undefined;
    try {
      const sigs = await this.connection.getSignaturesForAddress(listingPda, { limit: 1 });
      txSignature = sigs[0]?.signature;
    } catch {
      // explorer link is nice-to-have; the sale itself is confirmed by ownership
    }
    this.log(`[reconciler] ${shortAddress(tokenId)} SOLD to ${shortAddress(owner)}`);
    return await this.store.update(tokenId, {
      status: 'sold',
      buyerAddress: owner,
      soldAt: new Date().toISOString(),
      ...(txSignature ? { txSignature } : {}),
    });
  }
}
