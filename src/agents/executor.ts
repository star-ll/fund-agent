import OpenAI from 'openai';
import { config } from '../utils/config';
import { tools } from '../tools';
import { systemPrompt } from '../prompts';
import { getFundInfo, getFundNav, calcMetrics } from '../services/fund';
import { getFundManager } from '../services/manager';
import { getFundPortfolio, analyzePortfolio } from '../services/portfolio';
import { extractText } from '../services/ocr';

const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey });

type Message = OpenAI.Chat.ChatCompletionMessageParam;

export async function runAgent(userMessage: string, history: Message[]): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < 5; i++) {
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

    const toolResults = await Promise.all(
      choice.message.tool_calls.map(async (tc) => {
        const result = await dispatchTool(tc.function.name, JSON.parse(tc.function.arguments));
        return { tool_call_id: tc.id, result };
      }),
    );

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
