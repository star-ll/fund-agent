import OpenAI from 'openai';
import { config } from '../utils/config';
import { tools } from '../tools';
import { coreSystemPrompt } from '../prompts';

import { logger } from '../utils/logger';
import { dispatchTool, getToolLabel } from './tools';
import { loadProfile } from '../services/storage';
import { loadProfileFromDB, saveSummaryToDB } from '../services/user';
import { compressAllHistory } from '../history/summary-history';
import { buildMyHoldingsReply } from '../commands/my';
import { NEW_COMMAND_REPLY } from '../commands/new';
import { HELP_TEXT } from '../commands/help';
import type { UserProfile } from '../services/storage';

const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey });

type Message = OpenAI.Chat.ChatCompletionMessageParam;

function formatProfileForPrompt(profile: UserProfile): string {
  const lines: string[] = ['## 当前用户档案'];

  const riskMap = { low: '保守', medium: '稳健', high: '积极' };
  if (profile.risk_level) lines.push(`- 风险偏好：${riskMap[profile.risk_level]}`);
  if (profile.investment_years) lines.push(`- 投资年限：${profile.investment_years} 年`);
  if (profile.target_return) lines.push(`- 目标收益：${profile.target_return}`);
  if (profile.max_loss_tolerance) lines.push(`- 可承受最大亏损：${profile.max_loss_tolerance}`);
  if (profile.investment_goal) lines.push(`- 投资目标：${profile.investment_goal}`);
  if (profile.preferred_fund_types?.length) lines.push(`- 偏好基金类型：${profile.preferred_fund_types.join('、')}`);
  if (profile.monthly_investment) lines.push(`- 月均投入：${profile.monthly_investment}`);
  if (profile.portfolio_scale) lines.push(`- 总资产量级：${profile.portfolio_scale}`);
  if (profile.notes) lines.push(`- 备注：${profile.notes}`);

  if (profile.holdings.length > 0) {
    lines.push(`- 持仓基金（${profile.holdings.length} 只）：${profile.holdings.map((h) => h.fund_code).join('、')}`);
  }

  return lines.join('\n');
}

async function buildSystemPrompt(systemPrompt?: string, userId?: string): Promise<string> {
  const base = systemPrompt ? systemPrompt : coreSystemPrompt;
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });

  let profileSection = '';
  try {
    const profile = userId ? await loadProfileFromDB(userId) : loadProfile();
    if (profile) profileSection = `\n\n${formatProfileForPrompt(profile)}`;
  } catch {
    // 档案加载失败不影响主流程
  }

  return `今天是 ${today}。\n\n${base}${profileSection}`;
}



export interface RunAgentOptions {
  history?: Message[];
  onProgress?: (label: string) => void;
  systemPrompt?: string;
  // webhook 模式传入 userId，使用 MySQL；CLI 模式不传，使用本地文件
  userId?: string;
  // /new 命令执行后由调用方清除自身存储（Redis key、内存数组等）
  onClearHistory?: () => Promise<void>;
}

async function handleBuiltinCommand(
  input: string,
  history: Message[],
  userId?: string,
  onClearHistory?: () => Promise<void>,
): Promise<string> {
  const cmd = input.split(/\s+/)[0].toLowerCase();
  const tag = userId ? `cmd:${userId}` : 'cmd:cli';
  logger.info(tag, `执行内置指令 ${cmd}`);

  switch (cmd) {
    case '/new': {
      if (history.length > 0) {
        try {
          const summary = await compressAllHistory(history);
          if (summary && userId) await saveSummaryToDB(userId, summary);
        } catch (err) {
          logger.error(tag, '/new 压缩历史失败', err instanceof Error ? err.message : String(err));
        }
      }
      await onClearHistory?.();
      return NEW_COMMAND_REPLY;
    }
    case '/my':
      return buildMyHoldingsReply(userId);
    case '/help':
      return HELP_TEXT;
    default:
      return `未知指令 ${cmd}，输入 /help 查看可用指令。`;
  }
}

export async function runAgent(
  userMessage: string,
  options: RunAgentOptions = {},
): Promise<string> {
  const {
    history = [],
    userId,
    onProgress: progressCb,
    systemPrompt: historySystemPrompt,
    onClearHistory,
  } = options;

  // 内置指令路由
  const trimmed = userMessage.trim();
  if (trimmed.startsWith('/')) {
    return handleBuiltinCommand(trimmed, history, userId, onClearHistory);
  }

  const tag = userId ? `agent:${userId}` : 'agent:cli';
  logger.info(tag, '收到问题', userMessage);

  const messages: Message[] = [
    { role: 'system', content: await buildSystemPrompt(historySystemPrompt, userId) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const callLog: string[] = [];
  let webSearchCount = 0;
  const WEB_SEARCH_LIMIT = 5;
  const LOOP_LIMIT = 15;

  for (let i = 0; i < LOOP_LIMIT; i++) {
    logger.info(tag, `第 ${i + 1} 轮思考`);
    progressCb?.('思考中…');

    // LLM 推理
    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: config.llm.model,
        messages,
        tools,
      });
    } catch (err) {
      logger.error(tag, 'LLM 调用失败', err instanceof Error ? err.message : String(err));
      throw err;
    }

    const choice = response.choices[0];
    messages.push(choice.message);

    // 非工具调用 => 结束
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls) {
      const reply = choice.message.content ?? '';
      logger.info(tag, '回答完成', reply.slice(0, 200) + (reply.length > 200 ? '…' : ''));
      return callLog.length ? `${callLog.join('\n')}\n\n${reply}` : reply;
    }

    // 工具调用
    logger.info(tag, `本轮工具调用数: ${choice.message.tool_calls.length}`);

    // 顺序预处理：限流检查、日志、进度回调（保证 webSearchCount 计数准确）
    const prepared = choice.message.tool_calls.map((tc) => {
      const args = JSON.parse(tc.function.arguments);
      logger.info(tag, `工具调用: ${tc.function.name}`, args);
      progressCb?.(getToolLabel(tc.function.name, args));

      let skipContent: string | null = null;
      if (tc.function.name === 'web_search') {
        webSearchCount++;
        if (webSearchCount > WEB_SEARCH_LIMIT) {
          logger.warn(tag, `web_search 已达上限 ${WEB_SEARCH_LIMIT} 次，跳过`);
          skipContent = '已达搜索上限，请基于已有信息作答，不要再调用 web_search。';
        }
      }
      return { tc, args, skipContent };
    });

    // 并行派发所有工具
    const toolResults = await Promise.all(
      prepared.map(async ({ tc, args, skipContent }) => {
        if (skipContent) {
          return { tool_call_id: tc.id, callMessage: null as string | null, data: skipContent };
        }
        try {
          const dispatched = await dispatchTool(tc.function.name, args, userId);
          logger.debug(tag, `工具返回: ${tc.function.name}`, JSON.stringify(dispatched.data).slice(0, 200));
          return { tool_call_id: tc.id, callMessage: dispatched.callMessage, data: dispatched.data };
        } catch (err) {
          logger.error(tag, `工具异常: ${tc.function.name}`, err instanceof Error ? err.message : String(err));
          throw err;
        }
      }),
    );

    for (const { tool_call_id, callMessage, data } of toolResults) {
      if (callMessage) callLog.push(`> ${callMessage}`);
      messages.push({ role: 'tool', tool_call_id, content: JSON.stringify(data) });
    }
  }

  logger.warn(tag, '超出最大轮数');
  const fallback = '分析超出最大轮数，请重试。';
  return callLog.length ? `${callLog.join('\n')}\n\n${fallback}` : fallback;
}


