import { envNum, envStr, loadEnv, requireEnv } from '@agent-nft/shared';

loadEnv();

export const cfg = {
  rpcUrl: envStr('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
  network: envStr('SOLANA_NETWORK', 'devnet'),
  programId: () => requireEnv('MARKETPLACE_PROGRAM_ID'),
  buyerAgentAsset: () => requireEnv('BUYER_AGENT_ASSET_ADDRESS'),
  marketplaceUrl: envStr('MARKETPLACE_URL', 'http://localhost:3000'),
  budgetSOL: envNum('BUDGET_SOL', 0.05),
  maxPricePerNFT: envNum('MAX_PRICE_PER_NFT', 0.01),
  pollSeconds: envNum('POLL_SECONDS', 60),
  claudeModel: envStr('CLAUDE_MODEL', 'claude-sonnet-4-6'),
  /** Circuit breaker: hard cap on Claude evaluations across the process
   *  lifetime, so no bug can ever runaway-burn API credits again. */
  maxEvalsPerRun: envNum('MAX_EVALS_PER_RUN', 300),
  /** How long to idle after going dormant (broke / capped / Claude down). */
  dormantMinutes: envNum('DORMANT_MINUTES', 30),
};
