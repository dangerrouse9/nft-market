import { isRateLimit, retry, type Listing } from '@agent-nft/shared';
import { cfg } from './config';
import type { PendingListing } from './state';

/**
 * Publishes a listing to the marketplace API, retrying through transient
 * failures (RPC 429s surface here as a 400 "verification error"). A 409 means
 * the listing is already in the feed — treat that as success (idempotent), so
 * a retry that actually landed the first time doesn't loop forever.
 */
export async function registerListing(listing: PendingListing): Promise<void> {
  await retry(
    async () => {
      const response = await fetch(`${cfg.marketplaceUrl}/listings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(listing),
      });
      if (response.ok || response.status === 409) return;
      const body = await response.text();
      throw new Error(`Marketplace API rejected listing (${response.status}): ${body}`);
    },
    {
      attempts: 6,
      baseMs: 2_000,
      maxMs: 30_000,
      // Retry rate-limit-driven rejections, transient verification failures,
      // and network errors; a genuine validation failure (bad address, wrong
      // price) won't fix itself, so stop immediately.
      retryable: (err) => {
        if (isRateLimit(err)) return true;
        const msg = err instanceof Error ? err.message : String(err);
        if (/verification error/.test(msg)) return true; // RPC hiccup during on-chain check
        if (/rejected listing \((400|403)\)/.test(msg)) return false; // clean validation reject
        return true; // network error / unknown -> worth a retry
      },
      onRetry: (err, attempt, delay) =>
        console.warn(
          `[creator] publish retry ${attempt} in ${Math.round(delay / 1000)}s: ${
            (err as Error).message?.slice(0, 100)
          }`,
        ),
    },
  );
}
