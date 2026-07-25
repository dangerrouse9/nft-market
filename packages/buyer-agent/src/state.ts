import fs from 'node:fs';
import path from 'node:path';
import { envStr, resolveFromRoot } from '@agent-nft/shared';

const STATE_PATH = path.join(
  resolveFromRoot(envStr('DATA_DIR', 'data')),
  'buyer-state.json',
);

export interface BuyerState {
  spentSOL: number;
  /** tokenId -> decision. Cached permanently: a token is evaluated by Claude
   *  at most ONCE, ever. Never deleted — that is what prevents re-evaluation
   *  loops from burning API credits. */
  evaluated: Record<string, 'buy' | 'pass'>;
  /** tokenIds decided "buy" but not yet successfully purchased. Retried
   *  on-chain each poll with NO new Claude call. */
  pendingBuys: string[];
  purchases: { tokenId: string; priceSOL: number; signature: string; at: string }[];
}

export function loadState(): BuyerState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { spentSOL: 0, evaluated: {}, pendingBuys: [], purchases: [], ...raw };
  } catch {
    return { spentSOL: 0, evaluated: {}, pendingBuys: [], purchases: [] };
  }
}

export function saveState(state: BuyerState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}
