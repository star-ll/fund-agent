import express from 'express';
import { redis } from './services/redis';
import { runAgent } from './agents/executor';
import { loadProfileFromDB } from './services/user';
import { startupSummaryPrompt } from './prompts';
import { verifyDiscordSignature } from './discord/verify';
import { sendFollowup } from './discord/api';
import { config } from './utils/config';
import type OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const app = express();

// Discord 签名验证必须拿到原始 body，不能用 express.json() 先解析
app.use(express.raw({ type: 'application/json' }));

const HISTORY_TTL = 60 * 60 * 24;
const HISTORY_KEY = (uid: string) => `discord:history:${uid}`;

async function getHistory(userId: string): Promise<Message[]> {
  const raw = await redis.get(HISTORY_KEY(userId));
  return raw ? JSON.parse(raw) : [];
}

async function setHistory(userId: string, history: Message[]): Promise<void> {
  const trimmed = history.slice(-20);
  await redis.setex(HISTORY_KEY(userId), HISTORY_TTL, JSON.stringify(trimmed));
}

// ---------------------------------------------------------------------------
// POST /interactions  —  Discord interactions endpoint
// ---------------------------------------------------------------------------
app.post('/interactions', async (req, res) => {
  const signature = req.headers['x-signature-ed25519'] as string;
  const timestamp = req.headers['x-signature-timestamp'] as string;
  const rawBody = req.body as Buffer;

  if (!signature || !timestamp || !rawBody) {
    res.status(401).send('missing headers');
    return;
  }

  const valid = verifyDiscordSignature(
    config.discord.publicKey,
    signature,
    timestamp,
    rawBody.toString('utf8'),
  );
  if (!valid) {
    res.status(401).send('invalid signature');
    return;
  }

  const body = JSON.parse(rawBody.toString('utf8'));

  // PING — URL 验证
  if (body.type === 1) {
    res.json({ type: 1 });
    return;
  }

  // APPLICATION_COMMAND — slash command
  if (body.type === 2) {
    const userId = body.member?.user?.id ?? body.user?.id ?? 'unknown';
    const question: string = body.data?.options?.find((o: any) => o.name === 'question')?.value ?? '';

    if (!question) {
      res.json({ type: 4, data: { content: '请输入问题，例如：/ask 000001基金怎么样' } });
      return;
    }

    // 立即返回 deferred response，告知 Discord 稍等
    res.json({ type: 5 });

    // 异步处理，不阻塞响应
    setImmediate(async () => {
      try {
        const [history, profile] = await Promise.all([
          getHistory(userId),
          loadProfileFromDB(userId),
        ]);

        const effectiveHistory: Message[] = history.length === 0 && profile
          ? [{ role: 'assistant', content: startupSummaryPrompt(JSON.stringify(profile)) }]
          : history;

        const reply = await runAgent(question, {
          history: effectiveHistory,
          userId,
        });

        const newHistory: Message[] = [
          ...effectiveHistory,
          { role: 'user', content: question },
          { role: 'assistant', content: reply },
        ];
        await setHistory(userId, newHistory);

        // Discord 消息上限 2000 字，超出则截断
        const content = reply.length > 2000 ? reply.slice(0, 1997) + '...' : reply;
        await sendFollowup(body.token, content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await sendFollowup(body.token, `分析出错：${msg}`).catch(() => {});
      }
    });

    return;
  }

  res.status(400).send('unknown interaction type');
});

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export async function startWebhook(): Promise<void> {
  await redis.connect();
  app.listen(config.port, () => {
    console.log(`Webhook server running on port ${config.port}`);
    console.log(`Interactions endpoint: https://ink8.ink/interactions`);
  });
}
