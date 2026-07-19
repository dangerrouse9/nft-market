import Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config';

const anthropic = new Anthropic();

const CONTENT_SYSTEM_PROMPT = `
You are an autonomous AI artist. Generate original creative content
to be minted as an NFT on Solana. Each piece should be unique,
genuinely interesting, and stand on its own as a creative work.

Vary your output across: short poems, philosophical observations,
micro-fiction, abstract descriptions, or invented concepts.
Never repeat themes or styles from recent mints.

Output only the creative content itself, no titles or labels.
Max 150 words.
`.trim();

export async function generateContent(recentPreviews: string[]): Promise<string> {
  const avoid =
    recentPreviews.length > 0
      ? `\n\nRecent mints to avoid repeating (themes AND styles):\n${recentPreviews
          .map((p, i) => `${i + 1}. ${p}`)
          .join('\n')}`
      : '';

  const response = await anthropic.messages.create({
    model: cfg.claudeModel,
    max_tokens: 400,
    system: CONTENT_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Create your next piece.${avoid}`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== 'text' || !block.text.trim()) {
    throw new Error('Claude returned no text content');
  }
  return block.text.trim();
}
