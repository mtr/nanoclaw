import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesizeSpeech, type TtsConfig } from './tts.js';

// Mock the openai module
vi.mock('openai', () => {
  const mockArrayBuffer = new ArrayBuffer(8);
  return {
    default: class {
      audio = {
        speech: {
          create: vi.fn().mockResolvedValue({
            arrayBuffer: () => Promise.resolve(mockArrayBuffer),
          }),
        },
      };
    },
  };
});

// Mock env.ts
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ OPENAI_API_KEY: 'test-key' })),
}));

// Mock logger.ts to avoid pino initialization side effects
vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('synthesizeSpeech', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a buffer of audio data', async () => {
    const result = await synthesizeSpeech('Hello world');
    expect(result).not.toBeNull();
    expect(result!.audio).toBeInstanceOf(Buffer);
  });

  it('returns null when API key is missing', async () => {
    const { readEnvFile } = await import('./env.js');
    vi.mocked(readEnvFile).mockReturnValueOnce({});
    const result = await synthesizeSpeech('Hello');
    expect(result).toBeNull();
  });

  it('accepts custom config', async () => {
    const config: TtsConfig = {
      voice: 'marin',
      model: 'gpt-4o-mini-tts',
      instructions: 'Speak calmly',
    };
    const result = await synthesizeSpeech('Hello', config);
    expect(result).not.toBeNull();
  });

  it('includes character count in result', async () => {
    const text = 'Hello world';
    const result = await synthesizeSpeech(text);
    expect(result).not.toBeNull();
    expect(result!.characterCount).toBe(text.length);
  });
});
