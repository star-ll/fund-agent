import * as path from 'path';
import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
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
    // 只响应 @mention
    if (!client.user || !message.mentions.has(client.user)) return;

    const userId = message.author.id;
    // 去掉消息中的 @mention 部分，提取实际问题
    const question = message.content
      .replace(/<@!?\d+>/g, '')
      .trim();

    if (!question) {
      const thread = await message.startThread({
        name: '基金分析',
        autoArchiveDuration: 1440,
      });
      await thread.send('请在 @ 我的同时输入你的问题，例如：@基金助手 000001基金怎么样');
      return;
    }

    logger.info('gateway', `收到 @mention`, { userId, question });

    // 创建子区（thread），后续所有回复都在子区内进行
    const threadName = question.length > 80 ? question.slice(0, 77) + '...' : question;
    const thread = await message.startThread({
      name: threadName || '基金分析',
      autoArchiveDuration: 1440, // 24 小时
    });

    logger.info('gateway', `已创建子区: ${thread.name}`, { userId });

    // 在子区内发一条占位消息，后续通过 edit 更新进度
    const reply = await thread.send('⏳ 思考中…');

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

      // 流式累积文本 + 节流编辑，实现「打字机」效果
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

      // 最终编辑：确保完整内容都显示（convertTables 格式化 + 分段）
      const formatted = convertTables(answer);
      const chunks = splitMessage(formatted);
      await reply.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await thread.send(chunks[i]);
      }
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
