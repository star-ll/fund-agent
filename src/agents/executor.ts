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
import { MARKET_PROMPT } from '../commands/market';
import type { UserProfile } from '../services/storage';

const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey });

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ---------------------------------------------------------------------------
// Token 估算：混合中英文，2 字符 ≈ 1 token（略保守，适配中文比例高的场景）
// ---------------------------------------------------------------------------
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    // tool 消息的 content 是 JSON 字符串，长度同样按 2:1 算
    total += Math.ceil(content.length / 2);
    if ('tool_calls' in m && m.tool_calls) {
      total += Math.ceil(JSON.stringify(m.tool_calls).length / 2);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// 上下文溢出保护：超限时裁剪最旧的 tool 结果消息，保持 system+对话结构不变
// CONTEXT_LIMIT 按 1M token 的 85% 设，留 buffer 给下一轮推理输出
// ---------------------------------------------------------------------------
const CONTEXT_LIMIT = 850_000;

function trimContext(messages: Message[]): Message[] {
  // 找到 system 消息位置（应是第一条）
  const sysEnd = messages[0]?.role === 'system' ? 1 : 0;

  // 从前往后扫描：缩减旧 tool 消息的 content，每条约 200 字符后截断
  for (let i = sysEnd; i < messages.length; i++) {
    if (estimateTokens(messages) <= CONTEXT_LIMIT) break;

    const m = messages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 500) {
      // 尝试解析 JSON，裁剪数组元素；失败则直接字符串截断
      try {
        const parsed = JSON.parse(m.content);
        if (Array.isArray(parsed) && parsed.length > 5) {
          m.content = JSON.stringify(parsed.slice(0, 5)) + `\n…（已截断 ${parsed.length - 5} 条）`;
          continue;
        }
        if (typeof parsed === 'object' && parsed !== null) {
          // 对象类型，截断最长的字段
          let maxKey = '';
          let maxLen = 0;
          for (const [k, v] of Object.entries(parsed)) {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            if (s.length > maxLen) { maxKey = k; maxLen = s.length; }
          }
          if (maxLen > 300 && typeof parsed[maxKey] === 'string') {
            parsed[maxKey] = (parsed[maxKey] as string).slice(0, 300) + '…';
            m.content = JSON.stringify(parsed);
          }
        }
      } catch {
        // 非 JSON 文本，直接截断
        m.content = m.content.slice(0, 400) + '…(truncated)';
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// 流式 LLM 调用：支持文本 token 逐块输出，同时正确解析 tool_calls
// ---------------------------------------------------------------------------
interface StreamResult {
  content: string;
  tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
  finish_reason: string;
}

async function streamChatCompletion(
  messages: Message[],
  onStream?: (chunk: string) => void,
): Promise<StreamResult> {
  const stream = await client.chat.completions.create({
    model: config.llm.model,
    messages,
    tools,
    stream: true,
  });

  let content = '';
  const toolCallsMap = new Map<number, {
    id: string;
    function: { name: string; arguments: string };
  }>();
  let finishReason = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    // 文本内容 → 逐块回调
    if (delta.content) {
      content += delta.content;
      onStream?.(delta.content);
    }

    // 工具调用 → 累积拼接（streaming 中 name/arguments 分多段到达）
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCallsMap.has(idx)) {
          toolCallsMap.set(idx, { id: tc.id ?? '', function: { name: '', arguments: '' } });
        }
        const entry = toolCallsMap.get(idx)!;
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.function.name += tc.function.name;
        if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
      }
    }

    if (chunk.choices[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }
  }

  const tool_calls = toolCallsMap.size > 0
    ? Array.from(toolCallsMap.values()).map((tc, i) => ({
        id: tc.id,
        type: 'function' as const,
        function: tc.function,
        index: i,
      }))
    : undefined;

  return { content, tool_calls, finish_reason: finishReason };
}

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
  /** 流式回调：每收到一个 token 文本就调用一次，用于渐进式 UI 更新 */
  onStream?: (chunk: string) => void;
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
  systemPrompt?: string,
  onProgress?: (label: string) => void,
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
    case '/market':
      // 不在此处直接返回，而是把 prompt 交给 agent 执行，让 LLM 拉取数据后推理
      return runAgent(MARKET_PROMPT, { history, userId, systemPrompt, onProgress });
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
    onStream,
    systemPrompt: historySystemPrompt,
    onClearHistory,
  } = options;

  // 内置指令路由
  const trimmed = userMessage.trim();
  if (trimmed.startsWith('/')) {
    return handleBuiltinCommand(trimmed, history, userId, onClearHistory, historySystemPrompt, progressCb);
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
  const WEB_SEARCH_LIMIT = 20;
  const LOOP_LIMIT = 30;

  const formatDuration = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

  for (let i = 0; i < LOOP_LIMIT; i++) {
    logger.info(tag, `第 ${i + 1} 轮思考`);

    // 上下文溢出保护：超限时裁剪最旧的 tool 结果
    const est = estimateTokens(messages);
    if (est > CONTEXT_LIMIT) {
      logger.warn(tag, `上下文超限 ${est} > ${CONTEXT_LIMIT} tokens，触发裁剪`);
      trimContext(messages);
      const afterTrim = estimateTokens(messages);
      logger.info(tag, `裁剪后 token 数: ${afterTrim}`);
    }

    progressCb?.('思考中…');

    // 流式 LLM 推理
    let result: StreamResult;
    try {
      result = await streamChatCompletion(messages, onStream);
    } catch (err) {
      logger.error(tag, 'LLM 调用失败', err instanceof Error ? err.message : String(err));
      throw err;
    }

    // 构建 assistant 消息加入历史（流式模式下需要手动拼接）
    const assistantMsg: Message = {
      role: 'assistant',
      content: result.content || null,
    };
    if (result.tool_calls) {
      (assistantMsg as any).tool_calls = result.tool_calls;
    }
    messages.push(assistantMsg);

    // 非工具调用 => 结束，返回流式累积的内容
    if (result.finish_reason !== 'tool_calls' || !result.tool_calls) {
      const reply = result.content;
      logger.info(tag, '回答完成', reply.slice(0, 200) + (reply.length > 200 ? '…' : ''));
      return callLog.length ? `${callLog.join('\n')}\n\n${reply}` : reply;
    }

    // 工具调用
    logger.info(tag, `本轮工具调用数: ${result.tool_calls.length}`);

    // 顺序预处理：限流检查、日志、进度回调（保证 webSearchCount 计数准确）
    const prepared = result.tool_calls.map((tc) => {
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
          return { tool_call_id: tc.id, callLogLine: `> ⏭ ${getToolLabel(tc.function.name, args)} - 已达上限`, data: skipContent };
        }
        const t0 = Date.now();
        try {
          const dispatched = await dispatchTool(tc.function.name, args, userId);
          const elapsed = Date.now() - t0;
          logger.debug(tag, `工具返回: ${tc.function.name}`, JSON.stringify(dispatched.data).slice(0, 200));
          return {
            tool_call_id: tc.id,
            callLogLine: `> 🔧 ${dispatched.callMessage}（${formatDuration(elapsed)}）`,
            data: dispatched.data,
          };
        } catch (err) {
          const elapsed = Date.now() - t0;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(tag, `工具异常: ${tc.function.name}`, msg);
          return {
            tool_call_id: tc.id,
            callLogLine: `> ⚠ ${getToolLabel(tc.function.name, args)} - ${msg}（${formatDuration(elapsed)}）`,
            data: { error: `工具 ${tc.function.name} 调用失败：${msg}，请基于已有信息作答。` },
          };
        }
      }),
    );

    for (const { tool_call_id, callLogLine, data } of toolResults) {
      callLog.push(callLogLine);
      messages.push({ role: 'tool', tool_call_id, content: JSON.stringify(data) });
    }
  }

  logger.warn(tag, '超出最大轮数');
  const fallback = '分析超出最大轮数，请重试。';
  return callLog.length ? `${callLog.join('\n')}\n\n${fallback}` : fallback;
}


