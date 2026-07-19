export type ListingStatus = 'active' | 'sold' | 'delisted';

export interface Listing {
  /** Metaplex Core asset address */
  tokenId: string;
  /** ipfs:// or https:// metadata URI */
  contentUri: string;
  /** First 200 chars of the content */
  contentPreview: string;
  priceSOL: number;
  creatorAddress: string;
  sellerAddress: string;
  /** The seller's registered agent Core asset (proves the seller is an agent) */
  sellerAgentAsset: string;
  /** ISO timestamp */
  listedAt: string;
  status: ListingStatus;
  soldAt: string | null;
  buyerAddress: string | null;
  /** Optional Metaplex collection address */
  collection?: string;
  /** Signature of the sale transaction once sold */
  txSignature?: string;
  /** Creator royalty in basis points, read from the on-chain listing */
  royaltyBps?: number;
}

export interface AgentEvaluation {
  decision: 'buy' | 'pass';
  reasoning: string;
  confidence: number;
}

export interface TransactionResult {
  signature: string;
  explorerUrl: string;
  slot: number;
}

export interface MarketplaceStats {
  totalListed: number;
  totalSold: number;
  activeListings: number;
  volumeSOL: number;
  /** Royalties paid to creators on secondary sales */
  royaltiesSOL: number;
  /** Marketplace fees collected */
  feesSOL: number;
}
