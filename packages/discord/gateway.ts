import * as path from 'path';
import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { runAgent } from '../../src/agents/executor';
import { loadProfileFromDB } from '../../src/services/user';
import { buildSystemPrompt, startupSummaryPrompt } from '../../src/prompts';
import { getHistory, setHistory } from './history';
import { config } from '../../src/utils/config';
import { logger } from '../../src/utils/logger';

const systemPrompt = buildSystemPrompt(path.join(__dirname, 'prompts/output-format.md'));

export function startGateway(): void {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    logger.info('gateway', `Gateway 已连接，登录为 ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // 忽略 bot 自身消息
    if (message.author.bot) return;
    // 只响应 @mention
    if (!client.user || !message.mentions.has(client.user)) return;

    const userId = message.author.id;
    // 去掉消息中的 @mention 部分，提取实际问题
    const question = message.content
      .replace(/<@!?\d+>/g, '')
      .trim();

    if (!question) {
      await message.reply('请在 @ 我的同时输入你的问题，例如：@基金助手 000001基金怎么样');
      return;
    }

    logger.info('gateway', `收到 @mention`, { userId, question });

    // 先发一条占位消息，后续通过 edit 更新进度
    const reply = await message.reply('⏳ 思考中…');

    try {
      const [history, profile] = await Promise.all([
        getHistory(userId),
        loadProfileFromDB(userId),
      ]);

      const effectiveHistory = history.length === 0 && profile
        ? [{ role: 'assistant' as const, content: startupSummaryPrompt(JSON.stringify(profile)) }]
        : history;

      const answer = await runAgent(question, {
        history: effectiveHistory,
        userId,
        systemPrompt,
        onProgress: (label) => {
          reply.edit(`⏳ ${label}`).catch(() => {});
        },
      });

      const newHistory = [
        ...effectiveHistory,
        { role: 'user' as const, content: question },
        { role: 'assistant' as const, content: answer },
      ];
      await setHistory(userId, newHistory);

      // Discord 消息上限 2000 字
      const content = answer.length > 2000 ? answer.slice(0, 1997) + '...' : answer;
      await reply.edit(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('gateway', `处理异常 userId=${userId}`, err instanceof Error ? err.stack : msg);
      await reply.edit(`分析出错：${msg}`).catch(() => {});
    }
  });

  client.login(config.discord.botToken).catch((err) => {
    logger.error('gateway', 'Gateway 登录失败', err instanceof Error ? err.message : String(err));
  });
}
