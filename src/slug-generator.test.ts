import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateThreadSlug } from './slug-generator.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn(function () {
      return { messages: { create: mockCreate } };
    }),
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

describe('generateThreadSlug', () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
  });

  it('returns LLM-generated slug for a user message', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'x-twitter-setup' }],
    });

    const slug = await generateThreadSlug(
      'How do I set up X Twitter integration?',
      'test-api-key',
      [],
    );

    expect(slug).toBe('x-twitter-setup');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
      }),
    );
  });

  it('strips whitespace and normalizes LLM output', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '  Speaker Setup Guide  ' }],
    });

    const slug = await generateThreadSlug(
      'Help me set up my speakers',
      'key',
      [],
    );
    expect(slug).toBe('speaker-setup-guide');
  });

  it('avoids existing slugs by passing them in the prompt', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'murial-brainstorm-2' }],
    });

    const slug = await generateThreadSlug('I have an idea for Murial', 'key', [
      'murial-brainstorm',
    ]);

    expect(slug).toBe('murial-brainstorm-2');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('murial-brainstorm');
  });

  it('falls back to slugified message on API error', async () => {
    mockCreate.mockRejectedValue(new Error('API unavailable'));

    const slug = await generateThreadSlug('How to build a web app', 'key', []);

    expect(slug).toBe('how-to-build-a-web-app');
  });

  it('falls back when LLM returns empty text', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
    });

    const slug = await generateThreadSlug('My question', 'key', []);
    expect(slug).toBe('my-question');
  });

  it('truncates input to 500 chars', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'long-message' }],
    });

    const longMessage = 'a'.repeat(1000);
    await generateThreadSlug(longMessage, 'key', []);

    const callArgs = mockCreate.mock.calls[0][0];
    const userContent = callArgs.messages[0].content;
    expect(userContent.length).toBeLessThan(900);
  });
});
