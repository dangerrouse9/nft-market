import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchAsset } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  AGENT_IDENTITY_PROGRAM,
  SEED_AGENT_IDENTITY,
  SEED_LISTING,
  solToLamports,
} from '@agent-nft/shared';

export interface AgentCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Off-chain advisory check that a wallet controls a registered agent.
 * (The contract enforces the same thing on-chain at purchase time —
 * this just keeps junk out of the listing feed.)
 */
export async function verifyAgent(
  rpcUrl: string,
  agentAssetAddress: string,
  ownerWallet: string,
): Promise<AgentCheck> {
  const [identityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_AGENT_IDENTITY), new PublicKey(agentAssetAddress).toBuffer()],
    new PublicKey(AGENT_IDENTITY_PROGRAM),
  );

  const umi = createUmi(rpcUrl);
  const identity = await umi.rpc.getAccount(publicKey(identityPda.toBase58()));
  if (!identity.exists) {
    return { ok: false, reason: 'no agent identity registered for this asset' };
  }

  const asset = await fetchAsset(umi, publicKey(agentAssetAddress));
  if (asset.owner.toString() !== ownerWallet) {
    return { ok: false, reason: 'agent asset is not owned by this wallet' };
  }
  return { ok: true };
}

export interface OnChainListingCheck {
  ok: boolean;
  reason?: string;
  /** Royalty bps read from the on-chain listing account */
  royaltyBps?: number;
  /** Creator (royalty recipient) read from the on-chain listing account */
  creatorAddress?: string;
}

/**
 * Verifies a POSTed listing against the on-chain listing account, so the feed
 * can only contain NFTs that are genuinely escrowed for sale at the stated
 * price. Layout must match the Anchor `Listing` account:
 *   8 discriminator | 32 seller | 32 creator | 32 asset | 8 price u64 | 2 royalty u16 | 1 bump
 */
export async function verifyListingOnChain(
  rpcUrl: string,
  programId: string,
  tokenId: string,
  sellerAddress: string,
  priceSOL: number,
): Promise<OnChainListingCheck> {
  const asset = new PublicKey(tokenId);
  const [listingPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LISTING), asset.toBuffer()],
    new PublicKey(programId),
  );
  const connection = new Connection(rpcUrl, 'confirmed');
  const info = await connection.getAccountInfo(listingPda);
  if (!info) {
    return { ok: false, reason: 'no on-chain listing exists for this asset' };
  }
  if (info.owner.toBase58() !== programId || info.data.length < 115) {
    return { ok: false, reason: 'listing account is not owned by the marketplace program' };
  }
  const data = info.data;
  const seller = new PublicKey(data.subarray(8, 40)).toBase58();
  const creator = new PublicKey(data.subarray(40, 72)).toBase58();
  const onChainAsset = new PublicKey(data.subarray(72, 104)).toBase58();
  const priceLamports = Number(data.readBigUInt64LE(104));
  const royaltyBps = data.readUInt16LE(112);

  if (onChainAsset !== tokenId) return { ok: false, reason: 'listing asset mismatch' };
  if (seller !== sellerAddress) return { ok: false, reason: 'on-chain seller does not match' };
  if (priceLamports !== solToLamports(priceSOL)) {
    return { ok: false, reason: 'price does not match the on-chain listing' };
  }
  return { ok: true, royaltyBps, creatorAddress: creator };
}
