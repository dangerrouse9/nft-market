import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  envNum,
  envStr,
  loadEnv,
  resolveFromRoot,
  type Listing,
} from '@agent-nft/shared';
import { FileMarketStore, computeStats, type MarketStore } from './store';
import { PgMarketStore } from './pgStore';
import { Reconciler } from './reconciler';
import { verifyAgent, verifyListingOnChain } from './verify';

loadEnv();
const PORT = envNum('MARKETPLACE_PORT', 3000);
const RPC_URL = envStr('SOLANA_RPC_URL', 'https://api.devnet.solana.com');
const NETWORK = envStr('SOLANA_NETWORK', 'devnet');
const DATA_DIR = resolveFromRoot(envStr('DATA_DIR', 'data'));
const PROGRAM_ID = process.env.MARKETPLACE_PROGRAM_ID || '';
const FEE_BPS = envNum('MARKETPLACE_FEE_BPS', 150);
const RECONCILE_SECONDS = envNum('RECONCILE_SECONDS', 45);
const PUBLIC_URL = envStr(
  'MARKETPLACE_PUBLIC_URL',
  envStr('MARKETPLACE_URL', `http://localhost:${PORT}`),
);
const SKIP_AGENT_CHECK = process.env.SKIP_AGENT_CHECK === 'true';

const store: MarketStore = process.env.DATABASE_URL
  ? new PgMarketStore(process.env.DATABASE_URL)
  : new FileMarketStore(DATA_DIR);

const app = Fastify({
  logger: true,
  trustProxy: true, // Railway/reverse proxies: rate-limit by real client IP
  bodyLimit: 128 * 1024,
});

const reconciler = PROGRAM_ID ? new Reconciler(store, RPC_URL, PROGRAM_ID, (m) => app.log.info(m)) : null;

await app.register(cors, { origin: true, methods: ['GET', 'POST'] });
await app.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
  allowList: (req) => req.method === 'GET' && (req.url === '/health' || req.url.startsWith('/assets')),
});
await app.register(fastifyStatic, {
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  index: 'index.html',
});

app.get('/health', async () => ({ status: 'ok' }));

app.get('/market-info', async () => ({
  name: 'Agent Market',
  network: NETWORK,
  programId: PROGRAM_ID || null,
  feeBps: FEE_BPS,
  creatorAgentAsset: process.env.CREATOR_AGENT_ASSET_ADDRESS || null,
  buyerAgentAsset: process.env.BUYER_AGENT_ASSET_ADDRESS || null,
  listingsUrl: `${PUBLIC_URL}/listings`,
  docsUrl: process.env.DOCS_URL || null,
}));

app.get('/stats', async () => computeStats(await store.all(), FEE_BPS));

app.get('/listings', async (req) => {
  const { all } = req.query as { all?: string };
  return all === 'true' ? store.all() : store.active();
});

app.get('/listings/:tokenId', async (req, reply) => {
  const { tokenId } = req.params as { tokenId: string };
  const listing = await store.get(tokenId);
  if (!listing) return reply.code(404).send({ error: 'listing not found' });
  return listing;
});

const newListingSchema = {
  body: {
    type: 'object',
    required: [
      'tokenId',
      'contentUri',
      'contentPreview',
      'priceSOL',
      'creatorAddress',
      'sellerAddress',
      'sellerAgentAsset',
    ],
    properties: {
      tokenId: { type: 'string', minLength: 32, maxLength: 64 },
      contentUri: { type: 'string', maxLength: 512 },
      contentPreview: { type: 'string', maxLength: 400 },
      priceSOL: { type: 'number', exclusiveMinimum: 0 },
      creatorAddress: { type: 'string', minLength: 32, maxLength: 64 },
      sellerAddress: { type: 'string', minLength: 32, maxLength: 64 },
      sellerAgentAsset: { type: 'string', minLength: 32, maxLength: 64 },
      collection: { type: 'string', maxLength: 64 },
    },
  },
} as const;

app.post(
  '/listings',
  { schema: newListingSchema, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const body = req.body as Omit<Listing, 'listedAt' | 'status' | 'soldAt' | 'buyerAddress'>;

    // 1. The seller must be a registered agent that owns its identity asset.
    if (!SKIP_AGENT_CHECK) {
      const agent = await verifyAgent(RPC_URL, body.sellerAgentAsset, body.sellerAddress);
      if (!agent.ok) {
        return reply.code(403).send({ error: `agent verification failed: ${agent.reason}` });
      }
    }

    // 2. The NFT must be genuinely escrowed on-chain at the stated price.
    let royaltyBps: number | undefined;
    let creatorAddress = body.creatorAddress;
    if (PROGRAM_ID) {
      const chain = await verifyListingOnChain(
        RPC_URL,
        PROGRAM_ID,
        body.tokenId,
        body.sellerAddress,
        body.priceSOL,
      );
      if (!chain.ok) {
        return reply.code(403).send({ error: `on-chain verification failed: ${chain.reason}` });
      }
      royaltyBps = chain.royaltyBps;
      creatorAddress = chain.creatorAddress ?? creatorAddress;
    }

    const listing: Listing = {
      ...body,
      creatorAddress,
      ...(royaltyBps !== undefined ? { royaltyBps } : {}),
      listedAt: new Date().toISOString(),
      status: 'active',
      soldAt: null,
      buyerAddress: null,
    };
    try {
      await store.add(listing);
    } catch (err: any) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
    return reply.code(201).send(listing);
  },
);

// Status changes are never taken on trust: this endpoint just asks the server
// to re-check the chain for one listing right now (buyers poke it after a buy).
app.post(
  '/listings/:tokenId/sync',
  { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const { tokenId } = req.params as { tokenId: string };
    if (!(await store.get(tokenId))) return reply.code(404).send({ error: 'listing not found' });
    if (!reconciler) return reply.code(503).send({ error: 'reconciler disabled (no program id)' });
    const fresh = await reconciler.reconcile(tokenId);
    return fresh ?? reply.code(404).send({ error: 'listing not found' });
  },
);

// Self-hosted metadata store: fallback for NFT/agent metadata when Irys is
// unreachable. Content-addressed by hash.
app.post(
  '/metadata',
  { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    const raw = JSON.stringify(body, null, 2);
    if (raw.length > 100_000) {
      return reply.code(413).send({ error: 'metadata too large' });
    }
    const id = createHash('sha256').update(raw).digest('hex').slice(0, 24);
    await store.putMetadata(id, raw);
    return reply.code(201).send({ id, uri: `${PUBLIC_URL}/metadata/${id}` });
  },
);

app.get('/metadata/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[a-f0-9]{24}$/.test(id)) {
    return reply.code(400).send({ error: 'invalid metadata id' });
  }
  const raw = await store.getMetadata(id);
  if (raw === undefined) return reply.code(404).send({ error: 'metadata not found' });
  return reply.type('application/json').send(raw);
});

async function main() {
  await store.init();
  if (reconciler) {
    reconciler.start(RECONCILE_SECONDS);
    app.log.info(`reconciler watching chain every ${RECONCILE_SECONDS}s`);
  } else {
    app.log.warn('MARKETPLACE_PROGRAM_ID not set — on-chain verification and reconciler disabled');
  }
  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
