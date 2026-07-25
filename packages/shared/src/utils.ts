import { LAMPORTS_PER_SOL, SOLANA_EXPLORER_BASE } from './constants';

export function explorerUrl(
  value: string,
  network: string,
  kind: 'tx' | 'address' = 'tx',
): string {
  const cluster = network === 'mainnet-beta' ? '' : `?cluster=${network}`;
  return `${SOLANA_EXPLORER_BASE}/${kind}/${value}${cluster}`;
}

export function lamportsToSOL(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function ipfsToHttp(uri: string): string {
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  }
  return uri;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}..${address.slice(-4)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if an error looks like an RPC/API rate-limit (HTTP 429). */
export function isRateLimit(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('429') || m.includes('too many requests') || m.includes('rate limit');
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Return false to stop retrying and rethrow immediately (default: always retry) */
  retryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Retries an async operation with exponential backoff + jitter. Used to ride
 * out transient RPC 429s and propagation races on public Solana endpoints.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseMs ?? 1_000;
  const max = opts.maxMs ?? 30_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts.retryable && !opts.retryable(err)) throw err;
      if (i === attempts - 1) break;
      const delay = Math.min(max, base * 2 ** i) + Math.floor(Math.random() * 300);
      opts.onRetry?.(err, i + 1, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
