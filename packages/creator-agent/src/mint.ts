import { create, ruleSet } from '@metaplex-foundation/mpl-core';
import { generateSigner, type Umi } from '@metaplex-foundation/umi';
import { uploadMetadata } from '@agent-nft/shared';
import { cfg } from './config';

export interface MintResult {
  assetAddress: string;
  uri: string;
  name: string;
}

export async function mintNFT(umi: Umi, content: string): Promise<MintResult> {
  const name = `Agent Creation #${Date.now()}`;

  const metadata = {
    name,
    description: content,
    attributes: [
      { trait_type: 'created_by', value: 'autonomous_agent' },
      { trait_type: 'model', value: cfg.claudeModel },
    ],
    created_at: new Date().toISOString(),
  };
  const { uri } = await uploadMetadata(metadata, {
    irysUpload: () => umi.uploader.uploadJson(metadata),
    marketplaceUrl: cfg.marketplaceUrl,
  });

  const asset = generateSigner(umi);
  await create(umi, {
    asset,
    name,
    uri,
    plugins: [
      {
        type: 'Royalties',
        basisPoints: cfg.royaltyBps,
        creators: [{ address: umi.identity.publicKey, percentage: 100 }],
        ruleSet: ruleSet('None'),
      },
    ],
  }).sendAndConfirm(umi);

  return { assetAddress: asset.publicKey.toString(), uri, name };
}
