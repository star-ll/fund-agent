import OpenAI from 'openai';
import { config } from '../utils/config';
import { tools } from '../tools';
import { coreSystemPrompt } from '../prompts';

import { logger } from '../utils/logger';
import { dispatchTool, getToolLabel } from './tools';
import { loadProfile } from '../services/storage';
import { loadProfileFromDB } from '../services/user';
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
}

export async function runAgent(
  userMessage: string,
  historyOrOptions: Message[] | RunAgentOptions = [],
  onProgress?: (label: string) => void,
): Promise<string> {
  // 兼容旧调用方式 runAgent(msg, history, onProgress)
  let history: Message[];
  let userId: string | undefined;
  let progressCb: ((label: string) => void) | undefined;
  let historySystemPrompt:string|undefined

  if (Array.isArray(historyOrOptions)) {
    history = historyOrOptions;
    progressCb = onProgress;
  } else {
    history = historyOrOptions.history ?? [];
    userId = historyOrOptions.userId;
    progressCb = historyOrOptions.onProgress;
    historySystemPrompt = historyOrOptions.systemPrompt;
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
    const toolResults: { tool_call_id: string; data: unknown }[] = [];
    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      logger.info(tag, `工具调用: ${tc.function.name}`, args);
      progressCb?.(getToolLabel(tc.function.name, args));

      let dispatched: Awaited<ReturnType<typeof dispatchTool>>;
      try {
        if (tc.function.name === 'web_search') {
          webSearchCount++;
          if (webSearchCount > WEB_SEARCH_LIMIT) {
            logger.warn(tag, `web_search 已达上限 ${WEB_SEARCH_LIMIT} 次，跳过`);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '已达搜索上限，请基于已有信息作答，不要再调用 web_search。' });
            continue;
          }
        }
        dispatched = await dispatchTool(tc.function.name, args, userId);
        logger.debug(tag, `工具返回: ${tc.function.name}`, JSON.stringify(dispatched.data).slice(200));
      } catch (err) {
        logger.error(tag, `工具异常: ${tc.function.name}`, err instanceof Error ? err.message : String(err));
        throw err;
      }

      callLog.push(`> ${dispatched.callMessage}`);
      toolResults.push({ tool_call_id: tc.id, data: dispatched.data });
    }

    for (const { tool_call_id, data } of toolResults) {
      messages.push({ role: 'tool', tool_call_id, content: JSON.stringify(data) });
    }
  }

  logger.warn(tag, '超出最大轮数');
  const fallback = '分析超出最大轮数，请重试。';
  return callLog.length ? `${callLog.join('\n')}\n\n${fallback}` : fallback;
}


