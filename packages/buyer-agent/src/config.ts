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
};
