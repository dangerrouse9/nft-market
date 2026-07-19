import type { Listing } from '@agent-nft/shared';
import { cfg } from './config';

export async function registerListing(
  listing: Omit<Listing, 'listedAt' | 'status' | 'soldAt' | 'buyerAddress'>,
): Promise<Listing> {
  const response = await fetch(`${cfg.marketplaceUrl}/listings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(listing),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Marketplace API rejected listing (${response.status}): ${body}`);
  }
  return (await response.json()) as Listing;
}
