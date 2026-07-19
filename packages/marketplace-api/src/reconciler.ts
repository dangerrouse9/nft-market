import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchAsset } from '@metaplex-foundation/mpl-core';
import { publicKey as umiPk } from '@metaplex-foundation/umi';
import { SEED_ESCROW, SEED_LISTING, shortAddress, type Listing } from '@agent-nft/shared';
import type { MarketStore } from './store';

/**
 * Derives listing status from the blockchain instead of trusting API callers.
 *
 * For every listing the API thinks is active:
 *   - listing PDA still exists on-chain  -> still for sale
 *   - PDA closed + asset owned by seller -> delisted
 *   - PDA closed + asset owned by other  -> sold to that owner
 *
 * Runs on an interval and immediately when a client pokes /listings/:id/sync.
 */
export class Reconciler {
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: MarketStore,
    private readonly rpcUrl: string,
    programId: string,
    private readonly log: (msg: string) => void = console.log,
  ) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.programId = new PublicKey(programId);
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
    for (const listing of listings) {
      try {
        await this.reconcile(listing.tokenId);
      } catch (err: any) {
        this.log(`[reconciler] ${shortAddress(listing.tokenId)}: ${err.message}`);
      }
    }
  }

  /** Re-derives one listing's status from chain state. Returns the fresh listing. */
  async reconcile(tokenId: string): Promise<Listing | undefined> {
    const listing = await this.store.get(tokenId);
    if (!listing || listing.status !== 'active') return listing;

    const asset = new PublicKey(tokenId);
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_LISTING), asset.toBuffer()],
      this.programId,
    );
    const info = await this.connection.getAccountInfo(listingPda);
    if (info) return listing; // still escrowed and for sale

    // Listing account closed: find out who owns the asset now.
    const umi = createUmi(this.rpcUrl);
    const assetData = await fetchAsset(umi, umiPk(tokenId));
    const owner = assetData.owner.toString();

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_ESCROW), asset.toBuffer()],
      this.programId,
    );
    if (owner === escrowPda.toBase58()) return listing; // transient state, retry later

    if (owner === listing.sellerAddress) {
      this.log(`[reconciler] ${shortAddress(tokenId)} delisted (returned to seller)`);
      return await this.store.update(tokenId, { status: 'delisted' });
    }

    // Sold. The most recent transaction touching the listing PDA is the buy.
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
