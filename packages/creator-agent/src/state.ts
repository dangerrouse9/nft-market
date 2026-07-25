import fs from 'node:fs';
import path from 'node:path';
import { envStr, resolveFromRoot, type Listing } from '@agent-nft/shared';

const STATE_PATH = path.join(
  resolveFromRoot(envStr('DATA_DIR', 'data')),
  'creator-state.json',
);

/** A listing that is minted + escrowed on-chain but not yet published to the API. */
export type PendingListing = Omit<Listing, 'listedAt' | 'status' | 'soldAt' | 'buyerAddress'>;

interface CreatorState {
  recentPreviews: string[];
  totalMinted: number;
  /** Escrowed-but-unpublished listings, retried each cycle so nothing is lost. */
  pending: PendingListing[];
}

export function loadState(): CreatorState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { recentPreviews: [], totalMinted: 0, pending: [], ...raw };
  } catch {
    return { recentPreviews: [], totalMinted: 0, pending: [] };
  }
}

export function saveState(state: CreatorState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

export function recordMint(state: CreatorState, preview: string): void {
  state.recentPreviews = [...state.recentPreviews, preview].slice(-5);
  state.totalMinted += 1;
  saveState(state);
}

/** Persist an escrowed listing as pending BEFORE attempting to publish it. */
export function addPending(state: CreatorState, listing: PendingListing): void {
  if (!state.pending.some((p) => p.tokenId === listing.tokenId)) {
    state.pending.push(listing);
    saveState(state);
  }
}

export function removePending(state: CreatorState, tokenId: string): void {
  const before = state.pending.length;
  state.pending = state.pending.filter((p) => p.tokenId !== tokenId);
  if (state.pending.length !== before) saveState(state);
}
