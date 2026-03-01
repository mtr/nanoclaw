import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface TtsConfig {
  voice?: string;
  model?: string;
  instructions?: string;
  responseFormat?: 'opus' | 'mp3' | 'aac' | 'flac' | 'wav' | 'pcm';
}

export interface TtsResult {
  audio: Buffer;
  characterCount: number;
}

const DEFAULT_CONFIG: TtsConfig = {
  voice: 'marin',
  model: 'gpt-4o-mini-tts',
  responseFormat: 'opus',
};

let cachedInstructions: string | null = null;

function loadInstructions(): string {
  if (cachedInstructions !== null) return cachedInstructions;
  const instructionsFile =
    process.env.OPENAI_TTS_INSTRUCTIONS_FILE ||
    path.join(process.cwd(), 'config', 'tts-instructions.txt');
  try {
    cachedInstructions = fs.readFileSync(instructionsFile, 'utf-8').trim();
  } catch {
    cachedInstructions = '';
  }
  return cachedInstructions;
}

export function isTtsEnabled(): boolean {
  const env = readEnvFile(['OPENAI_TTS_ENABLED']);
  return env.OPENAI_TTS_ENABLED !== 'false';
}

export async function synthesizeSpeech(
  text: string,
  config?: TtsConfig,
): Promise<TtsResult | null> {
  const env = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_TTS_VOICE',
    'OPENAI_TTS_MODEL',
  ]);
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — TTS unavailable');
    return null;
  }

  const voice = config?.voice || env.OPENAI_TTS_VOICE || DEFAULT_CONFIG.voice!;
  const model = config?.model || env.OPENAI_TTS_MODEL || DEFAULT_CONFIG.model!;
  const instructions = config?.instructions || loadInstructions();
  const responseFormat =
    config?.responseFormat || DEFAULT_CONFIG.responseFormat!;

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey });

    const response = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: responseFormat,
      ...(instructions ? { instructions } : {}),
    });

    const arrayBuffer = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      characterCount: text.length,
    };
  } catch (err) {
    logger.error({ err }, 'TTS synthesis failed');
    return null;
  }
}
