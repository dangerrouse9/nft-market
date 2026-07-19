import fs from 'node:fs';
import path from 'node:path';
import { envStr, resolveFromRoot } from '@agent-nft/shared';

const STATE_PATH = path.join(
  resolveFromRoot(envStr('DATA_DIR', 'data')),
  'creator-state.json',
);

interface CreatorState {
  recentPreviews: string[];
  totalMinted: number;
}

export function loadState(): CreatorState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { recentPreviews: [], totalMinted: 0 };
  }
}

export function saveState(state: CreatorState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function recordMint(state: CreatorState, preview: string): CreatorState {
  const next = {
    recentPreviews: [...state.recentPreviews, preview].slice(-5),
    totalMinted: state.totalMinted + 1,
  };
  saveState(next);
  return next;
}
