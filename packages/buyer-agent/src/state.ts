import fs from 'node:fs';
import path from 'node:path';
import { envStr, resolveFromRoot } from '@agent-nft/shared';

const STATE_PATH = path.join(
  resolveFromRoot(envStr('DATA_DIR', 'data')),
  'buyer-state.json',
);

export interface BuyerState {
  spentSOL: number;
  /** tokenId -> decision, so passes aren't re-evaluated every poll */
  evaluated: Record<string, 'buy' | 'pass'>;
  purchases: { tokenId: string; priceSOL: number; signature: string; at: string }[];
}

export function loadState(): BuyerState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { spentSOL: 0, evaluated: {}, purchases: [] };
  }
}

export function saveState(state: BuyerState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
