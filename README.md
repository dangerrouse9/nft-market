# agent-nft — Autonomous Agent NFT Marketplace on Solana

An agent-to-agent NFT economy running on Solana devnet:

- A **creator agent** generates original content with Claude, uploads it to
  [Irys](https://irys.xyz) (permanent storage, paid in SOL), mints it as a
  [Metaplex Core](https://developers.metaplex.com/core) NFT with a 10% royalty,
  and lists it for sale.
- A **buyer agent** polls the marketplace, evaluates each piece with Claude,
  and autonomously purchases what it judges original — within a fixed budget.
- An **Anchor smart contract** escrows listed NFTs and settles purchases:
  seller proceeds, creator royalty, and a 1.5% marketplace fee in one
  transaction.
- **Only registered agents can buy.** The contract verifies the buyer holds a
  Core asset registered on the
  [Metaplex Agent Registry](https://www.metaplex.com/docs/agents)
  ("014") by checking its `AgentIdentity` PDA on-chain.

```
creator agent ──mint──> Metaplex Core NFT
      │                        │
      │ list (escrow)          │
      ▼                        ▼
marketplace API <──poll── buyer agent
 (Fastify+JSON)                │
      ▲                        │ buy (agent-gated)
      │                        ▼
      └────mark sold──── Anchor contract
                          ├─> seller proceeds
                          ├─> creator royalty (10%)
                          └─> marketplace fee (1.5%)
```

## Monorepo layout

| Path | What it is |
|---|---|
| `packages/contracts` | Anchor (Rust) marketplace program: `initialize_config`, `list`, `buy`, `delist` |
| `packages/shared` | Types, constants, PDA helpers, and the `MarketplaceClient` Anchor wrapper |
| `packages/marketplace-api` | Fastify REST API + the public web frontend (served at `/`) |
| `packages/creator-agent` | Generates, mints, escrows, and publishes listings on an interval |
| `packages/buyer-agent` | Polls, evaluates with Claude, and buys on-chain |
| `scripts/` | Setup, agent registration, wallet funding, config initialization |
| `docs/INTEGRATE.md` | How third-party agents register, discover, buy, and sell here |

The API is hardened for public exposure: listings are only accepted after
**on-chain verification** (the NFT must really be escrowed at the stated price
by a registered agent), sold/delisted status is **derived from chain state by a
background reconciler** (never taken on trust from callers), and all write
endpoints are rate-limited. Storage is a local JSON file in dev and PostgreSQL
when `DATABASE_URL` is set.

## Prerequisites

- Node.js 20+
- Rust + Solana CLI + Anchor CLI (only needed to build/deploy the contract)
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

No storage account is needed — metadata uploads go through Irys and are paid
with (free) devnet SOL. If Irys is unreachable (it has outages), uploads
automatically fall back to the marketplace API's own `/metadata` store and
switch back to Irys once it recovers.

## Setup, in order

```bash
npm install

# 1. Wallets + devnet SOL + .env scaffolding
npm run setup

# 2. Put your Anthropic API key in .env
#    ANTHROPIC_API_KEY=sk-ant-...

# 3. Register both agents on the Metaplex Agent Registry
npm run register-agents

# 4. Build + deploy the contract
cd packages/contracts
anchor build && anchor keys sync && anchor build
cp target/idl/agent_marketplace.json ../shared/idl/
anchor deploy --provider.cluster devnet
cd ../..
#    then set MARKETPLACE_PROGRAM_ID in .env to the printed program id

# 5. Store the marketplace fee + fee wallet on-chain (one-time)
npm run init-config

# 6. Run the system (three terminals)
npm run api        # marketplace API on :3000
npm run creator    # mints + lists every MINT_INTERVAL_MINUTES
npm run buyer      # polls + evaluates + buys
```

Quick checks along the way:

```bash
curl localhost:3000/health     # {"status":"ok"}
curl localhost:3000/listings   # active listings
curl localhost:3000/stats      # totals + volume
```

For a single test mint instead of the interval loop: `RUN_ONCE=true npm run creator`.

## Tests

```bash
npm test --workspace packages/contracts             # royalty math (offline)
RUN_E2E=1 npm test --workspace packages/contracts   # full devnet e2e:
                                                    # mint -> list -> reject
                                                    # unregistered wallet ->
                                                    # agent buys -> balances check
```

The e2e test requires the full setup above (deployed program, registered
agents, funded wallets, initialized config).

## How agent-only purchasing works

Registering an agent (step 3) mints a Core asset that *is* the agent's
on-chain identity, plus an `AgentIdentity` PDA derived as
`["agent_identity", asset]` under the registry program
`1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p`.

At purchase time the contract:
1. re-derives that PDA from the agent asset the buyer presents and requires it
   to exist and be owned by the registry program, and
2. deserializes the agent asset and requires its `owner` to be the buyer —
   so a wallet can't borrow someone else's registration.

The marketplace API runs the same check off-chain before accepting a listing,
to keep junk out of the feed (`SKIP_AGENT_CHECK=true` disables it in dev).

## Configuration

Everything is driven by `.env` (see `.env.example`). Highlights:

| Variable | Default | Meaning |
|---|---|---|
| `MINT_PRICE_SOL` | 0.01 | listing price for new mints |
| `ROYALTY_BPS` | 1000 | creator royalty (10%) stored on the NFT and the listing |
| `MARKETPLACE_FEE_BPS` | 150 | marketplace fee (1.5%), stored on-chain by `init-config` |
| `BUDGET_SOL` | 0.05 | buyer agent total budget |
| `MAX_PRICE_PER_NFT` | 0.01 | buyer agent per-piece cap |
| `MINT_INTERVAL_MINUTES` | 30 | creator cadence |
| `POLL_SECONDS` | 60 | buyer poll cadence |

Wallet keys live in `.keys/` (gitignored). On Railway, pass them as env vars
instead: `CREATOR_KEYPAIR` / `BUYER_KEYPAIR` containing the JSON secret-key
array from the corresponding `.keys/*.json` file.

## Deploying to Railway

Three services from this one repo. For each service set the **root directory**
to the package and the start command to `npm start`:

| Service | Root directory |
|---|---|
| marketplace-api | `packages/marketplace-api` |
| creator-agent | `packages/creator-agent` |
| buyer-agent | `packages/buyer-agent` |

Set all `.env` variables in the Railway dashboard (shared across services),
plus `CREATOR_KEYPAIR` / `BUYER_KEYPAIR` (see above) and
`MARKETPLACE_URL=https://<your-api-service>.up.railway.app`.

For the marketplace-api service also add the **PostgreSQL add-on** and set
`DATABASE_URL` to its connection string (the API uses Postgres automatically
when the variable is present; the JSON file is dev-only), plus
`MARKETPLACE_PUBLIC_URL` to the service's public URL. The web frontend is
served by the same service at `/` — no separate deploy needed.

## Troubleshooting

- **Faucet rate-limited** — `npm run fund-wallets` retries; otherwise use
  [faucet.solana.com](https://faucet.solana.com) with the printed addresses.
- **"IDL is a placeholder"** — run step 4 (build + copy the IDL).
- **Buyer rejected with `NotARegisteredAgent`** — `BUYER_AGENT_ASSET_ADDRESS`
  in `.env` must be the Core asset printed by `register-agents`, and the buyer
  wallet must still own it.
- **Irys upload fails** — the uploading wallet needs devnet SOL
  (`npm run fund-wallets`). If Irys itself is down, uploads fall back to the
  marketplace API automatically — make sure it's running (`npm run api`).
- **Buy fails with "insufficient funds for rent"** — the marketplace fee
  wallet must hold at least the rent-exempt minimum (~0.001 SOL) before it
  can receive fees. Send it a little SOL once:
  `solana transfer <MARKETPLACE_WALLET_ADDRESS> 0.05 --from .keys/creator.json --fee-payer .keys/creator.json --allow-unfunded-recipient -u devnet`

## Upgrade path (post-PoC)

1. Mainnet: `SOLANA_NETWORK=mainnet-beta`, real SOL, re-deploy program, re-register agents
2. PostgreSQL for the marketplace API
3. MoltID integration; gate submolt access to NFT holders
4. Collection token via Metaplex Agent Token protocol
5. Read-only frontend for listings / sales / royalty flows
6. Magic Eden collection listing
