import express from 'express';
import { parseStringPromise } from 'xml2js';
import { redis } from './services/redis';
import { runAgent } from './agents/executor';
import { loadProfileFromDB } from './services/user';
import { startupSummaryPrompt } from './prompts';
import { verifySignature, decrypt } from './wecom/crypto';
import { sendText } from './wecom/api';
import { config } from './utils/config';
import type OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const app = express();
app.use(express.text({ type: '*/xml' }));
app.use(express.json());

const HISTORY_TTL = 60 * 60 * 24; // 对话历史保留 24h
const HISTORY_KEY = (uid: string) => `wework:history:${uid}`;

async function getHistory(userId: string): Promise<Message[]> {
  const raw = await redis.get(HISTORY_KEY(userId));
  return raw ? JSON.parse(raw) : [];
}

async function setHistory(userId: string, history: Message[]): Promise<void> {
  // 最多保留最近 20 条，防止 context 过大
  const trimmed = history.slice(-20);
  await redis.setex(HISTORY_KEY(userId), HISTORY_TTL, JSON.stringify(trimmed));
}

// ---------------------------------------------------------------------------
// GET /fund  —  企微 URL 验证
// ---------------------------------------------------------------------------
app.get('/fund', (req, res) => {
  console.log('[verify] url:', req.url);
  console.log('[verify] query:', JSON.stringify(req.query));
  const msg_signature = req.query['msg_signature'] as string;
  const timestamp = req.query['timestamp'] as string;
  const nonce = req.query['nonce'] as string;
  const echostr = req.query['echostr'] as string;
  console.log('[verify] echostr len:', echostr?.length ?? 0);
  if (!verifySignature(msg_signature, timestamp, nonce, echostr)) {
    console.log('[verify] signature error, token:', config.wework.token?.slice(0, 4));
    res.status(403).send('signature error');
    return;
  }
  try {
    const plain = decrypt(echostr);
    console.log('[verify] success, plain len:', plain.length);
    res.send(plain);
  } catch (e) {
    console.log('[verify] decrypt error:', e);
    res.status(500).send('decrypt error');
  }
});

// ---------------------------------------------------------------------------
// POST /fund  —  接收企微消息
// ---------------------------------------------------------------------------
app.post('/fund', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query as Record<string, string>;

  let xml: Record<string, any>;
  try {
    const parsed = await parseStringPromise(req.body as string, { explicitArray: false });
    xml = parsed.xml;
  } catch {
    res.send('<xml><MsgType>text</MsgType></xml>');
    return;
  }

  // 先回 200，防止企微超时重发
  res.send('');

  const encrypted = Array.isArray(xml.Encrypt) ? xml.Encrypt[0] : xml.Encrypt;
  if (!verifySignature(msg_signature, timestamp, nonce, encrypted)) return;

  let innerXml: Record<string, any>;
  try {
    const decrypted = decrypt(encrypted);
    const inner = await parseStringPromise(decrypted, { explicitArray: false });
    innerXml = inner.xml;
  } catch {
    return;
  }

  const msgType = String(Array.isArray(innerXml.MsgType) ? innerXml.MsgType[0] : innerXml.MsgType);
  const fromUser = String(Array.isArray(innerXml.FromUserName) ? innerXml.FromUserName[0] : innerXml.FromUserName);

  if (msgType !== 'text') {
    await sendText(fromUser, '暂时只支持文字消息，图片分析功能开发中~');
    return;
  }

  const content = String(Array.isArray(innerXml.Content) ? innerXml.Content[0] : innerXml.Content).trim();
  if (!content) return;

  try {
    const [history, profile] = await Promise.all([
      getHistory(fromUser),
      loadProfileFromDB(fromUser),
    ]);

    // 首次对话且有档案，注入摘要作为 assistant 开场白
    const effectiveHistory: Message[] = history.length === 0 && profile
      ? [{ role: 'assistant', content: startupSummaryPrompt(JSON.stringify(profile)) }]
      : history;

    const reply = await runAgent(content, {
      history: effectiveHistory,
      weworkUserId: fromUser,
    });

    const newHistory: Message[] = [
      ...effectiveHistory,
      { role: 'user', content },
      { role: 'assistant', content: reply },
    ];
    await setHistory(fromUser, newHistory);

    // 企微消息不支持 ANSI，清除颜色码
    const plain = reply.replace(/\x1b\[[0-9;]*m/g, '');
    await sendText(fromUser, plain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(fromUser, `分析出错：${msg}`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export async function startWebhook(): Promise<void> {
  await redis.connect();
  app.listen(config.port, () => {
    console.log(`Webhook server running on port ${config.port}`);
    console.log(`Endpoint: https://ink8.ink/fund`);
  });
}
