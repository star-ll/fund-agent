import OpenAI from 'openai';
import { config } from '../utils/config';
import { tools } from '../tools';
import { systemPrompt } from '../prompts';
import { getFundInfo, getFundNav, calcMetrics } from '../services/fund';
import { getFundManager } from '../services/manager';
import { getFundPortfolio, analyzePortfolio } from '../services/portfolio';
import { extractText } from '../services/ocr';
import { loadProfile, saveProfile } from '../services/storage';

const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey });

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const TOOL_LABELS: Record<string, string> = {
  get_fund_info:     '获取基金信息…',
  get_fund_nav:      '获取净值历史…',
  get_fund_manager:  '获取基金经理…',
  get_fund_portfolio:'获取持仓明细…',
  get_user_profile:  '读取用户档案…',
  save_user_profile: '保存用户档案…',
  read_image:        '识别图片文字…',
  analyze_portfolio: '分析持仓组合…',
};

export async function runAgent(
  userMessage: string,
  history: Message[],
  onProgress?: (label: string) => void,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < 5; i++) {
    onProgress?.('思考中…');
    const response = await client.chat.completions.create({
      model: config.llm.model,
      messages,
      tools,
    });

    const choice = response.choices[0];
    messages.push(choice.message);

    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls) {
      return choice.message.content ?? '';
    }

    // 串行执行 tool calls，每次更新进度提示
    const toolResults: { tool_call_id: string; result: unknown }[] = [];
    for (const tc of choice.message.tool_calls) {
      onProgress?.(TOOL_LABELS[tc.function.name] ?? `${tc.function.name}…`);
      const result = await dispatchTool(tc.function.name, JSON.parse(tc.function.arguments));
      toolResults.push({ tool_call_id: tc.id, result });
    }

    for (const { tool_call_id, result } of toolResults) {
      messages.push({ role: 'tool', tool_call_id, content: JSON.stringify(result) });
    }
  }

  return '分析超出最大轮数，请重试。';
}

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
      return loadProfile() ?? { message: '暂无用户档案，请先告知持仓信息或上传截图。' };

    case 'save_user_profile':
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
