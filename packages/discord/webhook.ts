import * as path from 'path';
import express from 'express';
import { redis } from '../../src/services/redis';
import { runAgent } from '../../src/agents/executor';
import { loadProfileFromDB } from '../../src/services/user';
import { buildSystemPrompt, startupSummaryPrompt } from '../../src/prompts';
import { verifyDiscordSignature } from './verify';
import { sendFollowup } from './api';
import { config } from '../../src/utils/config';
import { logger } from '../../src/utils/logger';
import type OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const app = express();
const systemPrompt = buildSystemPrompt(path.join(__dirname, 'prompts/output-format.md'));

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
    logger.info('webhook', 'Discord PING 验证');
    res.json({ type: 1 });
    return;
  }

  // APPLICATION_COMMAND — slash command
  if (body.type === 2) {
    const userId = body.member?.user?.id ?? body.user?.id ?? 'unknown';
    const question: string = body.data?.options?.find((o: any) => o.name === 'question')?.value ?? '';

    logger.info('webhook', `收到指令 /ask`, { userId, question });

    if (!question) {
      logger.warn('webhook', `用户 ${userId} 未填写问题`);
      res.json({ type: 4, data: { content: '请输入问题，例如：/ask 000001基金怎么样' } });
      return;
    }

    // 立即返回 deferred response，告知 Discord 稍等
    res.json({ type: 5 });
    logger.info('webhook', `已返回 deferred response，开始异步处理 userId=${userId}`);

    // 异步处理，不阻塞响应
    setImmediate(async () => {
      try {
        logger.info('webhook', `加载历史和档案 userId=${userId}`);
        const [history, profile] = await Promise.all([
          getHistory(userId),
          loadProfileFromDB(userId),
        ]);
        logger.info('webhook', `历史消息数: ${history.length}，档案: ${profile ? '有' : '无'}`);

        const effectiveHistory: Message[] = history.length === 0 && profile
          ? [{ role: 'assistant', content: startupSummaryPrompt(JSON.stringify(profile)) }]
          : history;

        const reply = await runAgent(question, {
          history: effectiveHistory,
          userId,
          systemPrompt,
        });

        const newHistory: Message[] = [
          ...effectiveHistory,
          { role: 'user', content: question },
          { role: 'assistant', content: reply },
        ];
        await setHistory(userId, newHistory);

        // Discord 消息上限 2000 字，超出则截断
        const content = reply.length > 2000 ? reply.slice(0, 1997) + '...' : reply;
        logger.info('webhook', `发送回复 userId=${userId}，长度=${content.length}`);
        await sendFollowup(body.token, content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('webhook', `处理异常 userId=${userId}`, err instanceof Error ? err.stack : msg);
        await sendFollowup(body.token, `分析出错：${msg}`).catch((e) => {
          logger.error('webhook', 'sendFollowup 失败', e instanceof Error ? e.message : String(e));
        });
      }
    });

    return;
  }

  logger.warn('webhook', `未知 interaction type: ${body.type}`);
  res.status(400).send('unknown interaction type');
});

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export async function startWebhook(): Promise<void> {
  await redis.connect();
  app.listen(config.port, () => {
    logger.info('webhook', `服务启动，端口 ${config.port}`);
    logger.info('webhook', `Interactions endpoint: POST /interactions`);
  });
}
