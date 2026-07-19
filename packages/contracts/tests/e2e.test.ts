/**
 * Contract tests.
 *
 * The royalty-math tests always run:
 *   npm test --workspace packages/contracts
 *
 * The on-chain end-to-end test runs against DEVNET and needs the full setup
 * (deployed program, funded wallets, registered agents, initialized config):
 *   RUN_E2E=1 npm test --workspace packages/contracts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner } from '@metaplex-foundation/umi';
import { create, ruleSet } from '@metaplex-foundation/mpl-core';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  MarketplaceClient,
  loadAgentKeypair,
  loadEnv,
  requireEnv,
  envNum,
  sleep,
  solToLamports,
} from '@agent-nft/shared';

function computeSplit(price: number, royaltyBps: number, feeBps: number) {
  const royalty = Math.floor((price * royaltyBps) / 10_000);
  const fee = Math.floor((price * feeBps) / 10_000);
  return { royalty, fee, sellerProceeds: price - royalty - fee };
}

test('royalty math: 10% royalty + 1.5% fee on 0.01 SOL', () => {
  const price = solToLamports(0.01);
  const { royalty, fee, sellerProceeds } = computeSplit(price, 1000, 150);
  assert.equal(royalty, 1_000_000);
  assert.equal(fee, 150_000);
  assert.equal(sellerProceeds, 8_850_000);
  assert.equal(royalty + fee + sellerProceeds, price);
});

test('royalty math: rounding never over-pays', () => {
  for (const price of [1, 999, 12_345_678, 987_654_321]) {
    for (const [r, f] of [[1000, 150], [333, 77], [5000, 2000]] as const) {
      const { royalty, fee, sellerProceeds } = computeSplit(price, r, f);
      assert.ok(royalty + fee + sellerProceeds <= price);
      assert.ok(sellerProceeds >= 0);
    }
  }
});

test('devnet e2e: mint -> list -> agent-gated buy', { skip: !process.env.RUN_E2E }, async () => {
  loadEnv();
  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const programId = requireEnv('MARKETPLACE_PROGRAM_ID');
  const buyerAgentAsset = new PublicKey(requireEnv('BUYER_AGENT_ASSET_ADDRESS'));
  const feeBps = envNum('MARKETPLACE_FEE_BPS', 150);
  const royaltyBps = 1000;
  const priceSOL = 0.005;

  const creatorKp = loadAgentKeypair('creator');
  const buyerKp = loadAgentKeypair('buyer');

  // 1. Mint a test NFT from the creator wallet
  const umi = createUmi(rpcUrl);
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(creatorKp.secretKey)));
  const asset = generateSigner(umi);
  await create(umi, {
    asset,
    name: `E2E Test ${Date.now()}`,
    uri: 'https://example.com/e2e-test.json',
    plugins: [
      {
        type: 'Royalties',
        basisPoints: royaltyBps,
        creators: [{ address: umi.identity.publicKey, percentage: 100 }],
        ruleSet: ruleSet('None'),
      },
    ],
  }).sendAndConfirm(umi);
  const assetPk = new PublicKey(asset.publicKey.toString());
  console.log(`  minted test asset ${assetPk.toBase58()}`);

  // 2. List it
  const creatorClient = new MarketplaceClient(rpcUrl, creatorKp, programId);
  await creatorClient.list(
    assetPk,
    creatorKp.publicKey,
    solToLamports(priceSOL),
    royaltyBps,
  );
  console.log('  listed');

  // 3. A wallet with no agent registration must be rejected
  const outsider = Keypair.generate();
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: creatorKp.publicKey,
      toPubkey: outsider.publicKey,
      lamports: solToLamports(0.02),
    }),
  );
  await sendAndConfirmTransaction(creatorClient.connection, fundTx, [creatorKp]);
  const outsiderClient = new MarketplaceClient(rpcUrl, outsider, programId);
  await assert.rejects(
    // A random pubkey has no AgentIdentity PDA -> NotARegisteredAgent
    outsiderClient.buy(assetPk, Keypair.generate().publicKey),
    /NotARegisteredAgent|not a registered agent/i,
  );
  console.log('  unregistered wallet correctly rejected');

  // 4. The registered buyer agent purchases
  const connection = creatorClient.connection;
  const config = await creatorClient.fetchConfig();
  const marketplaceWallet = new PublicKey(config.marketplaceWallet.toString());
  const sellerBefore = await connection.getBalance(creatorKp.publicKey);
  const marketBefore = await connection.getBalance(marketplaceWallet);

  const buyerClient = new MarketplaceClient(rpcUrl, buyerKp, programId);
  const sig = await buyerClient.buy(assetPk, buyerAgentAsset);
  console.log(`  purchased: ${sig}`);

  const sellerAfter = await connection.getBalance(creatorKp.publicKey);
  const marketAfter = await connection.getBalance(marketplaceWallet);

  const price = solToLamports(priceSOL);
  const { fee } = computeSplit(price, royaltyBps, feeBps);
  // Primary sale: seller == creator, so royalty folds into seller proceeds.
  // Seller also gets the listing account rent back, hence >=.
  assert.ok(
    sellerAfter - sellerBefore >= price - fee,
    `seller received ${sellerAfter - sellerBefore}, expected >= ${price - fee}`,
  );
  assert.equal(marketAfter - marketBefore, fee, 'marketplace fee mismatch');

  // 5. The buyer now owns the asset (poll: devnet RPC reads can lag the
  // confirmed transaction by several seconds)
  const { fetchAsset } = await import('@metaplex-foundation/mpl-core');
  const { publicKey: umiPk } = await import('@metaplex-foundation/umi');
  let owner = '';
  for (let attempt = 0; attempt < 10 && owner !== buyerKp.publicKey.toBase58(); attempt++) {
    if (attempt > 0) await sleep(2_000);
    const bought = await fetchAsset(umi, umiPk(assetPk.toBase58()));
    owner = bought.owner.toString();
  }
  assert.equal(owner, buyerKp.publicKey.toBase58());
  console.log('  buyer owns the asset — e2e complete');
});
