import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Listing, MarketplaceStats } from '@agent-nft/shared';

/**
 * Storage behind the API. Two implementations:
 *  - FileMarketStore: JSON on disk, for local development
 *  - PgMarketStore (pgStore.ts): PostgreSQL, for hosted deploys where the
 *    filesystem is ephemeral (selected automatically when DATABASE_URL is set)
 */
export interface MarketStore {
  init(): Promise<void>;
  all(): Promise<Listing[]>;
  active(): Promise<Listing[]>;
  get(tokenId: string): Promise<Listing | undefined>;
  add(listing: Listing): Promise<void>;
  update(tokenId: string, patch: Partial<Listing>): Promise<Listing | undefined>;
  putMetadata(id: string, raw: string): Promise<void>;
  getMetadata(id: string): Promise<string | undefined>;
}

export function conflictError(tokenId: string): Error {
  return Object.assign(new Error(`Listing ${tokenId} already exists`), {
    statusCode: 409,
  });
}

export function computeStats(listings: Listing[], feeBps: number): MarketplaceStats {
  const sold = listings.filter((l) => l.status === 'sold');
  const volumeSOL = sold.reduce((sum, l) => sum + l.priceSOL, 0);
  // Royalties count only secondary sales — on a primary sale the creator IS
  // the seller, so the royalty is just part of their proceeds.
  const royaltiesSOL = sold
    .filter((l) => l.sellerAddress !== l.creatorAddress)
    .reduce((sum, l) => sum + (l.priceSOL * (l.royaltyBps ?? 1000)) / 10_000, 0);
  const feesSOL = (volumeSOL * feeBps) / 10_000;
  return {
    totalListed: listings.length,
    totalSold: sold.length,
    activeListings: listings.filter((l) => l.status === 'active').length,
    volumeSOL,
    royaltiesSOL,
    feesSOL,
  };
}

export class FileMarketStore implements MarketStore {
  private listings: Listing[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly metadataDir: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'listings.json');
    this.metadataDir = path.join(dataDir, 'metadata');
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.listings = (JSON.parse(raw).listings ?? []) as Listing[];
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
      this.listings = [];
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ listings: this.listings }, null, 2));
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }

  async all(): Promise<Listing[]> {
    return this.listings;
  }

  async active(): Promise<Listing[]> {
    return this.listings.filter((l) => l.status === 'active');
  }

  async get(tokenId: string): Promise<Listing | undefined> {
    return this.listings.find((l) => l.tokenId === tokenId);
  }

  async add(listing: Listing): Promise<void> {
    if (await this.get(listing.tokenId)) throw conflictError(listing.tokenId);
    this.listings.push(listing);
    await this.persist();
  }

  async update(tokenId: string, patch: Partial<Listing>): Promise<Listing | undefined> {
    const listing = await this.get(tokenId);
    if (!listing) return undefined;
    Object.assign(listing, patch);
    await this.persist();
    return listing;
  }

  async putMetadata(id: string, raw: string): Promise<void> {
    await fs.mkdir(this.metadataDir, { recursive: true });
    await fs.writeFile(path.join(this.metadataDir, `${id}.json`), raw);
  }

  async getMetadata(id: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(this.metadataDir, `${id}.json`), 'utf8');
    } catch {
      return undefined;
    }
  }
}
