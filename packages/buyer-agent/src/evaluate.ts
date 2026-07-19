import Anthropic from '@anthropic-ai/sdk';
import type { AgentEvaluation, Listing } from '@agent-nft/shared';
import { cfg } from './config';

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `
You are an autonomous agent with a Solana wallet on ${cfg.network}.
You have a total budget of ${cfg.budgetSOL} SOL to spend on NFTs.
Never spend more than ${cfg.maxPricePerNFT} SOL on a single piece.

For each NFT listing, respond ONLY with a JSON object:
{
  "decision": "buy" | "pass",
  "reasoning": "one sentence explaining your decision",
  "confidence": 0.0-1.0
}

Buy criteria: Is this content genuinely original or interesting?
Does it have qualities a thoughtful collector would value?
Pass on anything generic, repetitive, or low-effort.
`.trim();

export async function evaluateListing(listing: Listing): Promise<AgentEvaluation> {
  const response = await anthropic.messages.create({
    model: cfg.claudeModel,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Evaluate this NFT listing:\n${JSON.stringify(
          {
            contentPreview: listing.contentPreview,
            priceSOL: listing.priceSOL,
            listedAt: listing.listedAt,
          },
          null,
          2,
        )}`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Claude returned no text');

  // Strip markdown fences if the model added them
  const raw = block.text.replace(/```(?:json)?/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Could not parse evaluation: ${raw.slice(0, 120)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as AgentEvaluation;
  if (parsed.decision !== 'buy' && parsed.decision !== 'pass') {
    throw new Error(`Invalid decision: ${parsed.decision}`);
  }
  return parsed;
}
