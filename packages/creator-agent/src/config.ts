import {
  envBool,
  envNum,
  envStr,
  loadEnv,
  requireEnv,
} from '@agent-nft/shared';

loadEnv();

export const cfg = {
  rpcUrl: envStr('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
  network: envStr('SOLANA_NETWORK', 'devnet'),
  programId: () => requireEnv('MARKETPLACE_PROGRAM_ID'),
  creatorAgentAsset: () => requireEnv('CREATOR_AGENT_ASSET_ADDRESS'),
  marketplaceUrl: envStr('MARKETPLACE_URL', 'http://localhost:3000'),
  mintPriceSOL: envNum('MINT_PRICE_SOL', 0.01),
  mintIntervalMinutes: envNum('MINT_INTERVAL_MINUTES', 30),
  royaltyBps: envNum('ROYALTY_BPS', 1000),
  runOnce: envBool('RUN_ONCE', false),
  claudeModel: envStr('CLAUDE_MODEL', 'claude-sonnet-4-6'),
  /** Irys uploads on devnet go through the devnet node and cost devnet SOL */
  irysAddress:
    envStr('SOLANA_NETWORK', 'devnet') === 'devnet'
      ? 'https://devnet.irys.xyz'
      : undefined,
};
