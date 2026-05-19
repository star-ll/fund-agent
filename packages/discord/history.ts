import { redis } from '../../src/services/redis';
import type OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const HISTORY_TTL = 60 * 60 * 24;
const HISTORY_KEY = (uid: string) => `discord:history:${uid}`;

export async function getHistory(userId: string): Promise<Message[]> {
  const raw = await redis.get(HISTORY_KEY(userId));
  return raw ? JSON.parse(raw) : [];
}

export async function setHistory(userId: string, history: Message[]): Promise<void> {
  const trimmed = history.slice(-20);
  await redis.setex(HISTORY_KEY(userId), HISTORY_TTL, JSON.stringify(trimmed));
}
