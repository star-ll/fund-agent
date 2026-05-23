import OpenAI from 'openai';
import { config } from '../utils/config';
import { tools } from '../tools';
import { coreSystemPrompt } from '../prompts';
import { getFundInfo, getFundNav, calcMetrics } from '../services/fund';
import { getFundManager } from '../services/manager';
import { getFundPortfolio, analyzePortfolio } from '../services/portfolio';
import { extractText } from '../services/ocr';
import { loadProfile, saveProfile } from '../services/storage';
import { loadProfileFromDB, saveProfileToDB } from '../services/user';
import { webSearch } from '../services/search';
import { logger } from '../utils/logger';

const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey });

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const TOOL_LABELS: Record<string, string> = {
  get_fund_info:      '获取基金信息…',
  get_fund_nav:       '获取净值历史…',
  get_fund_manager:   '获取基金经理…',
  get_fund_portfolio: '获取持仓明细…',
  get_user_profile:   '读取用户档案…',
  save_user_profile:  '保存用户档案…',
  read_image:         '识别图片文字…',
  analyze_portfolio:  '分析持仓组合…',
  web_search:         '搜索互联网…',
};

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
  let effectiveSystemPrompt = coreSystemPrompt;

  if (Array.isArray(historyOrOptions)) {
    history = historyOrOptions;
    progressCb = onProgress;
  } else {
    history = historyOrOptions.history ?? [];
    userId = historyOrOptions.userId;
    progressCb = historyOrOptions.onProgress;
    effectiveSystemPrompt = historyOrOptions.systemPrompt ?? coreSystemPrompt;
  }

  const tag = userId ? `agent:${userId}` : 'agent:cli';
  logger.info(tag, '收到问题', userMessage);

  const messages: Message[] = [
    { role: 'system', content: effectiveSystemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < 5; i++) {
    logger.info(tag, `第 ${i + 1} 轮思考`);
    progressCb?.('思考中…');

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

    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls) {
      const reply = choice.message.content ?? '';
      logger.info(tag, '回答完成', reply.slice(0, 200) + (reply.length > 200 ? '…' : ''));
      return reply;
    }

    logger.info(tag, `本轮工具调用数: ${choice.message.tool_calls.length}`);

    const toolResults: { tool_call_id: string; result: unknown }[] = [];
    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      logger.info(tag, `工具调用: ${tc.function.name}`, args);
      progressCb?.(TOOL_LABELS[tc.function.name] ?? `${tc.function.name}…`);

      let result: unknown;
      try {
        result = await dispatchTool(tc.function.name, args, userId);
        logger.debug(tag, `工具返回: ${tc.function.name}`, JSON.stringify(result).slice(200));
      } catch (err) {
        logger.error(tag, `工具异常: ${tc.function.name}`, err instanceof Error ? err.message : String(err));
        throw err;
      }

      toolResults.push({ tool_call_id: tc.id, result });
    }

    for (const { tool_call_id, result } of toolResults) {
      messages.push({ role: 'tool', tool_call_id, content: JSON.stringify(result) });
    }
  }

  logger.warn(tag, '超出最大轮数');
  return '分析超出最大轮数，请重试。';
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  userId?: string,
): Promise<unknown> {
  switch (name) {
    case 'get_fund_info':
      return getFundInfo(args.fund_code as string);

    case 'get_fund_nav': {
      const navList = await getFundNav(
        args.fund_code as string,
        '单位净值走势',
        (args.period as string) ?? '成立来',
      );
      return { recent: navList.slice(-30), metrics: calcMetrics(navList) };
    }

    case 'get_fund_manager':
      return getFundManager(args.fund_code as string);

    case 'get_fund_portfolio':
      return getFundPortfolio(args.fund_code as string, args.date as string);

    case 'get_user_profile':
      if (userId) {
        return (await loadProfileFromDB(userId)) ?? { message: '暂无档案，请先提供持仓信息。' };
      }
      return loadProfile() ?? { message: '暂无用户档案，请先告知持仓信息或上传截图。' };

    case 'save_user_profile':
      if (userId) {
        return saveProfileToDB(userId, args as Parameters<typeof saveProfileToDB>[1]);
      }
      return saveProfile(args as Parameters<typeof saveProfile>[0]);

    case 'read_image':
      return { text: await extractText(args.file_path as string) };

    case 'analyze_portfolio':
      return analyzePortfolio(
        (args.holdings as Array<{ fund_code: string; shares: number; cost: number }>).map((h) => ({
          fundCode: h.fund_code,
          shares: h.shares,
          cost: h.cost,
        })),
      );

    case 'web_search':
      return webSearch(args.query as string, args.max_results as number | undefined);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
