import pg from 'pg';
import type { Listing } from '@agent-nft/shared';
import { conflictError, type MarketStore } from './store';

/** PostgreSQL store for hosted deploys. Listings are kept as JSONB blobs so
 *  the schema never drifts from the shared Listing type. */
export class PgMarketStore implements MarketStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 5,
      // Railway-managed Postgres uses TLS with an internal CA
      ssl: databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS listings (
        token_id  TEXT PRIMARY KEY,
        data      JSONB NOT NULL,
        listed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS metadata (
        id  TEXT PRIMARY KEY,
        raw TEXT NOT NULL
      );
    `);
  }

  async all(): Promise<Listing[]> {
    const res = await this.pool.query('SELECT data FROM listings ORDER BY listed_at ASC');
    return res.rows.map((r) => r.data as Listing);
  }

  async active(): Promise<Listing[]> {
    const res = await this.pool.query(
      `SELECT data FROM listings WHERE data->>'status' = 'active' ORDER BY listed_at ASC`,
    );
    return res.rows.map((r) => r.data as Listing);
  }

  async get(tokenId: string): Promise<Listing | undefined> {
    const res = await this.pool.query('SELECT data FROM listings WHERE token_id = $1', [tokenId]);
    return res.rows[0]?.data as Listing | undefined;
  }

  async add(listing: Listing): Promise<void> {
    const res = await this.pool.query(
      'INSERT INTO listings (token_id, data) VALUES ($1, $2) ON CONFLICT (token_id) DO NOTHING',
      [listing.tokenId, listing],
    );
    if (res.rowCount === 0) throw conflictError(listing.tokenId);
  }

  async update(tokenId: string, patch: Partial<Listing>): Promise<Listing | undefined> {
    const res = await this.pool.query(
      'UPDATE listings SET data = data || $2::jsonb WHERE token_id = $1 RETURNING data',
      [tokenId, JSON.stringify(patch)],
    );
    return res.rows[0]?.data as Listing | undefined;
  }

  async putMetadata(id: string, raw: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO metadata (id, raw) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET raw = $2',
      [id, raw],
    );
  }

  async getMetadata(id: string): Promise<string | undefined> {
    const res = await this.pool.query('SELECT raw FROM metadata WHERE id = $1', [id]);
    return res.rows[0]?.raw as string | undefined;
  }
}
