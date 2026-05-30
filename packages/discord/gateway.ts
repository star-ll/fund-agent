import * as path from 'path';
import { Client, GatewayIntentBits, Events, Message, TextChannel } from 'discord.js';
import { runAgent } from '../../src/agents/executor';
import { loadProfileFromDB, loadSummaryFromDB } from '../../src/services/user';
import { buildSystemPrompt, startupSummaryPrompt } from '../../src/prompts';
import { buildSummaryMessages } from '../../src/history/summary-history';
import { getHistory, setHistory, clearHistory } from './history';
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

    const isMention = !!client.user && message.mentions.has(client.user);
    const isThread = message.channel.isThread();

    // 只响应 @mention（频道消息）或子区内的消息
    if (!isMention && !isThread) return;

    const userId = message.author.id;

    // 子区消息（非 @mention）：验证 bot 是该子区成员
    if (isThread && !isMention) {
      try {
        await message.channel.members.fetch(client.user!.id);
      } catch {
        return; // bot 不是该子区成员，忽略
      }
    }

    // 提取问题：@mention 时去掉 @ 标记，子区内直接用原文
    const question = isMention
      ? message.content.replace(/<@!?\d+>/g, '').trim()
      : message.content.trim();

    if (!question) {
      if (isMention) {
        const thread = await message.startThread({
          name: '基金分析',
          autoArchiveDuration: 1440,
        });
        await thread.send('请在 @ 我的同时输入你的问题，例如：@基金助手 000001基金怎么样');
      }
      return;
    }

    logger.info('gateway', `收到消息`, { userId, question, isMention, isThread });

    // 频道 @mention → 创建子区；子区内消息 → 直接在当前子区回复
    const channel = isMention && !isThread
      ? await message.startThread({
          name: question.length > 80 ? question.slice(0, 77) + '...' : question,
          autoArchiveDuration: 1440,
        })
      : message.channel;

    if (isMention && !isThread) {
      logger.info('gateway', `已创建子区: ${(channel as any).name}`, { userId });
    }

    await processInChannel(channel, userId, question);
  });

  client.login(config.discord.botToken).catch((err) => {
    logger.error('gateway', 'Gateway 登录失败', err instanceof Error ? err.message : String(err));
  });
}

// ---------------------------------------------------------------------------
// 在指定 channel/thread 中处理用户问题（被 @mention 和子区消息共用）
// ---------------------------------------------------------------------------
async function processInChannel(
  channel: TextChannel | any,
  userId: string,
  question: string,
): Promise<void> {
  const reply = await channel.send('⏳ 思考中…');

  try {
    const [history, profile] = await Promise.all([
      getHistory(userId),
      loadProfileFromDB(userId),
    ]);

    let effectiveHistory = history;
    if (history.length === 0) {
      const dbSummary = await loadSummaryFromDB(userId);
      if (dbSummary) {
        effectiveHistory = buildSummaryMessages(dbSummary);
      } else if (profile) {
        effectiveHistory = [{ role: 'assistant' as const, content: startupSummaryPrompt(JSON.stringify(profile)) }];
      }
    }

    let historyCleared = false;
    const progressPromises: Promise<unknown>[] = [];

    let streamedContent = '';
    let lastStreamEdit = 0;
    const STREAM_THROTTLE_MS = 300;

    const answer = await runAgent(question, {
      history: effectiveHistory,
      userId,
      systemPrompt,
      onProgress: (label) => {
        progressPromises.push(reply.edit(`⏳ ${label}`).catch(() => {}));
      },
      onStream: (chunk) => {
        streamedContent += chunk;
        const now = Date.now();
        if (now - lastStreamEdit >= STREAM_THROTTLE_MS) {
          lastStreamEdit = now;
          progressPromises.push(reply.edit(streamedContent).catch(() => {}));
        }
      },
      onClearHistory: async () => {
        await clearHistory(userId);
        historyCleared = true;
      },
    });

    await Promise.allSettled(progressPromises);

    if (!historyCleared) {
      const newHistory = [
        ...effectiveHistory,
        { role: 'user' as const, content: question },
        { role: 'assistant' as const, content: answer },
      ];
      await setHistory(userId, newHistory);
    }

    const formatted = convertTables(answer);
    const chunks = splitMessage(formatted);
    await reply.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await channel.send(chunks[i]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('gateway', `处理异常 userId=${userId}`, err instanceof Error ? err.stack : msg);
    await reply.edit(`分析出错：${msg}`).catch(() => {});
  }
}

function splitMessage(text: string, limit = 2000): string[] {
  const chunks: string[] = [];
  while (text.length > 0) {
    if (text.length <= limit) {
      chunks.push(text);
      break;
    }
    // 在 limit 内找最后一个换行符，避免在句子中间截断
    let pos = text.lastIndexOf('\n', limit);
    if (pos <= 0) pos = limit;
    chunks.push(text.slice(0, pos));
    text = text.slice(pos).trimStart();
  }
  return chunks;
}

// 把 LLM 输出的 markdown 表格转成卡片流格式
function convertTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (/\|/.test(lines[i])) {
      const tableLines: string[] = [];
      while (i < lines.length && /\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }

      // 过滤分隔行（|---|---| 这种）
      const rows = tableLines
        .filter(l => !/^\s*\|?[\s\-:|]+\|/.test(l))
        .map(l => l.split('|').map(c => c.trim()).filter(c => c.length > 0))
        .filter(r => r.length > 0);

      if (rows.length === 0) continue;

      const [header, ...dataRows] = rows;

      if (dataRows.length === 0) {
        // 只有一行，直接拼成一行文字
        result.push(header.join('  '));
      } else {
        // 多行数据：合并成一个代码块，行之间用分隔符
        result.push('```');
        dataRows.forEach((row, idx) => {
          header.forEach((h, col) => result.push(`${h}：${row[col] ?? ''}`));
          if (idx < dataRows.length - 1) result.push('────────────────');
        });
        result.push('```');
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
}
