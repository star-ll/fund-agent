import { redis } from '../../src/services/redis';
import { summaryHistory } from '../../src/history/summary-history';
import type OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const HISTORY_TTL = 60 * 60 * 24;
const HISTORY_KEY = (uid: string) => `discord:history:${uid}`;

export async function getHistory(userId: string): Promise<Message[]> {
  const raw = await redis.get(HISTORY_KEY(userId));
  return raw ? JSON.parse(raw) : [];
}

export async function setHistory(userId: string, history: Message[]): Promise<void> {
  const compressed = await summaryHistory(history);
  await redis.setex(HISTORY_KEY(userId), HISTORY_TTL, JSON.stringify(compressed));
}

export async function clearHistory(userId: string): Promise<void> {
  await redis.del(HISTORY_KEY(userId));
}
