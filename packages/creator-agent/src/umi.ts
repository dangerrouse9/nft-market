import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, type Umi } from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import type { Keypair } from '@solana/web3.js';
import { cfg } from './config';

export function makeUmi(keypair: Keypair): Umi {
  const umi = createUmi(cfg.rpcUrl).use(
    irysUploader(cfg.irysAddress ? { address: cfg.irysAddress } : {}),
  );
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(keypairIdentity(umiKeypair));
  return umi;
}
