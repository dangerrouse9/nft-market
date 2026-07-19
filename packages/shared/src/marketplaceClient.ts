import { AnchorProvider, BN, Program } from '@anchor-lang/core';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_IDENTITY_PROGRAM,
  MPL_CORE_PROGRAM,
  SEED_AGENT_IDENTITY,
  SEED_CONFIG,
  SEED_ESCROW,
  SEED_LISTING,
} from './constants';

const IDL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'idl',
  'agent_marketplace.json',
);

export function loadIdl(): any {
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
  if (idl.__placeholder) {
    throw new Error(
      'The marketplace IDL is a placeholder. Build the contract first:\n' +
        '  cd packages/contracts && anchor build\n' +
        '  cp target/idl/agent_marketplace.json ../shared/idl/',
    );
  }
  return idl;
}

/** Minimal wallet adapter around a Keypair for AnchorProvider. */
class KeypairWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }
  async signTransaction<T extends { partialSign?: (kp: Keypair) => void; sign?: (kps: Keypair[]) => void }>(
    tx: T,
  ): Promise<T> {
    if (typeof tx.partialSign === 'function') {
      tx.partialSign(this.payer);
    } else if (typeof tx.sign === 'function') {
      tx.sign([this.payer]);
    }
    return tx;
  }
  async signAllTransactions<T extends object>(txs: T[]): Promise<T[]> {
    for (const tx of txs) await this.signTransaction(tx as any);
    return txs;
  }
}

export class MarketplaceClient {
  readonly connection: Connection;
  readonly program: Program;
  readonly keypair: Keypair;

  constructor(rpcUrl: string, keypair: Keypair, programId?: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.keypair = keypair;
    const provider = new AnchorProvider(
      this.connection,
      new KeypairWallet(keypair) as any,
      { commitment: 'confirmed' },
    );
    const idl = loadIdl();
    if (programId) idl.address = programId;
    this.program = new Program(idl, provider);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  configPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_CONFIG)],
      this.programId,
    )[0];
  }

  listingPda(asset: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_LISTING), asset.toBuffer()],
      this.programId,
    )[0];
  }

  escrowPda(asset: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_ESCROW), asset.toBuffer()],
      this.programId,
    )[0];
  }

  agentIdentityPda(agentAsset: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_AGENT_IDENTITY), agentAsset.toBuffer()],
      new PublicKey(AGENT_IDENTITY_PROGRAM),
    )[0];
  }

  async initializeConfig(
    marketplaceWallet: PublicKey,
    feeBps: number,
  ): Promise<string> {
    return await (this.program.methods as any)
      .initializeConfig(feeBps)
      .accountsPartial({
        admin: this.keypair.publicKey,
        config: this.configPda(),
        marketplaceWallet,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async fetchConfig(): Promise<any> {
    return await (this.program.account as any).config.fetch(this.configPda());
  }

  async fetchListing(asset: PublicKey): Promise<any> {
    return await (this.program.account as any).listing.fetch(
      this.listingPda(asset),
    );
  }

  async list(
    asset: PublicKey,
    creator: PublicKey,
    priceLamports: number | bigint,
    royaltyBps: number,
    collection?: PublicKey,
  ): Promise<string> {
    return await (this.program.methods as any)
      .list(new BN(priceLamports.toString()), royaltyBps)
      .accountsPartial({
        seller: this.keypair.publicKey,
        asset,
        collection: collection ?? null,
        creator,
        listing: this.listingPda(asset),
        escrowAuthority: this.escrowPda(asset),
        mplCoreProgram: new PublicKey(MPL_CORE_PROGRAM),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async buy(asset: PublicKey, buyerAgentAsset: PublicKey, collection?: PublicKey): Promise<string> {
    const listing = await this.fetchListing(asset);
    const config = await this.fetchConfig();
    // The program rejects duplicate mutable accounts, so when the seller is
    // also the royalty recipient we omit creator and the royalty stays with
    // the seller's proceeds.
    const sellerIsCreator = listing.creator.equals(listing.seller);
    return await (this.program.methods as any)
      .buy()
      .accountsPartial({
        buyer: this.keypair.publicKey,
        buyerAgentAsset,
        buyerAgentIdentity: this.agentIdentityPda(buyerAgentAsset),
        config: this.configPda(),
        listing: this.listingPda(asset),
        asset,
        collection: collection ?? null,
        escrowAuthority: this.escrowPda(asset),
        seller: listing.seller,
        creator: sellerIsCreator ? null : listing.creator,
        marketplaceWallet: config.marketplaceWallet,
        mplCoreProgram: new PublicKey(MPL_CORE_PROGRAM),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async delist(asset: PublicKey, collection?: PublicKey): Promise<string> {
    return await (this.program.methods as any)
      .delist()
      .accountsPartial({
        seller: this.keypair.publicKey,
        listing: this.listingPda(asset),
        asset,
        collection: collection ?? null,
        escrowAuthority: this.escrowPda(asset),
        mplCoreProgram: new PublicKey(MPL_CORE_PROGRAM),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
}
