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
