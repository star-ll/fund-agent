import OpenAI from "openai/index.mjs";
import { logger } from "../utils/logger";
import { config } from '../utils/config';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey });

const SUMMARY_MARKER = '[[HISTORY_SUMMARY]]';
const MAX_RAW = 10;
const COMPRESS_TRIGGER = 15;
const COMPRESS_BATCH = 5;

const COMPRESS_SYSTEM_PROMPT = `你是一个对话压缩器，服务于 AI 基金分析助理。

## 背景

系统已将用户的持仓档案（基金代码、风险偏好、投资目标、资金规模等）持久化存储，并在每次对话开始时自动注入 system prompt。

因此，**压缩摘要不需要重复持仓和档案信息**，只需保留档案里没有、但对后续建议有影响的会话层内容。

## 必须保留

1. **本次会话给出过的推荐**：具体基金代码或产品名、推荐理由、推荐方向（买入/持有/减仓/关注）
2. **用户的明确否定**：拒绝的产品或观点，以及拒绝理由（避免再次推荐）
3. **尚未完成的问题**：用户追问了但还没有完整回答的问题
4. **会话内的临时约束**：用户在对话中提到的偏好限制（如"不要封闭期产品"），若尚未写入档案
5. **关键分析结论**：影响后续建议方向的重要判断（如"当前持仓权益比例偏高，暂不加仓股票型"）
6. **用户表达的操作意向**：如"打算下周卖出 XX"、"等3个月定期到期后再投"

## 可以丢弃

- 闲聊、问候、感谢
- 已完整回答过的基础知识问题
- 重复询问档案中已有的信息（系统会自动注入）

## 输出格式

【本轮推荐记录】
- 买入：[基金代码] [产品名]（理由：xxx）
- 持有：[基金代码]（理由：xxx）
- 减仓/止盈：[基金代码]（理由：xxx）
- 关注：[基金代码或品类]（触发条件：xxx）
- 无推荐：（如本段对话未涉及）

【用户否定过的产品/观点】
- [基金代码或类别]：拒绝原因
- 无

【未完成的问题】
- 用户追问：xxx（待回答）
- 无

【会话内临时约束】（补充档案未覆盖的偏好）
- xxx
- 无

【关键结论与操作意向】
一到三句话，总结当前局面和用户的下一步打算。若无特别内容可省略此节。`;



function extractSummary(history: Message[]): { summary: string | null; rawMessages: Message[] } {
  if (
    history.length >= 2 &&
    history[0].role === 'user' &&
    typeof history[0].content === 'string' &&
    history[0].content.startsWith(SUMMARY_MARKER) &&
    history[1].role === 'assistant'
  ) {
    return {
      summary: history[0].content.slice(SUMMARY_MARKER.length).trim(),
      rawMessages: history.slice(2),
    };
  }
  return { summary: null, rawMessages: history };
}

export function buildSummaryMessages(summary: string): Message[] {
  return [
    { role: 'user', content: `${SUMMARY_MARKER}\n${summary}` },
    { role: 'assistant', content: '已了解之前的对话背景，将在此基础上继续为您提供建议。' },
  ];
}

async function callLLMCompress(existingSummary: string | null, messagesToCompress: Message[]): Promise<string> {
  const conversationText = messagesToCompress
    .map((m) => {
      const role = m.role === 'user' ? '用户' : '助理';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${role}：${content}`;
    })
    .join('\n\n');

  const userContent = existingSummary
    ? `以下是之前的对话摘要：\n\n${existingSummary}\n\n---\n\n以下是需要合并进摘要的新对话片段：\n\n${conversationText}\n\n请将上述新对话内容整合进原摘要，输出更新后的完整摘要。`
    : `以下是需要压缩的对话内容：\n\n${conversationText}\n\n请按照指定格式输出压缩摘要。`;

  const response = await client.chat.completions.create({
    model: config.llm.model,
    messages: [
      { role: 'system', content: COMPRESS_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });

  return response.choices[0].message.content ?? '';
}

// 当原始记录达到 COMPRESS_TRIGGER 条时，压缩最旧的 COMPRESS_BATCH 条，始终保留最近 MAX_RAW 条原始记录。
// 返回新的 history 数组：[摘要占位消息对（如有）, ...最近 MAX_RAW 条原始消息]
export async function summaryHistory(history: Message[]): Promise<Message[]> {
  const { summary, rawMessages } = extractSummary(history);

  if (rawMessages.length < COMPRESS_TRIGGER) {
    return history;
  }

  logger.info('history', `触发历史压缩：原始记录 ${rawMessages.length} 条，压缩最早 ${COMPRESS_BATCH} 条`);

  const toCompress = rawMessages.slice(0, COMPRESS_BATCH);
  const toKeep = rawMessages.slice(-MAX_RAW);

  let newSummary: string;
  try {
    newSummary = await callLLMCompress(summary, toCompress);
  } catch (err) {
    logger.error('history', '历史压缩失败，保留原始记录', err instanceof Error ? err.message : String(err));
    return history;
  }

  logger.info('history', '历史压缩完成');
  return [...buildSummaryMessages(newSummary), ...toKeep];
}

// /new 命令调用：将全部历史（含已有摘要）一次性压缩为纯文本摘要字符串，存入 DB。
export async function compressAllHistory(history: Message[]): Promise<string> {
  if (history.length === 0) return '';

  const { summary, rawMessages } = extractSummary(history);

  if (rawMessages.length === 0) return summary ?? '';

  logger.info('history', `全量压缩：共 ${rawMessages.length} 条原始记录`);

  const result = await callLLMCompress(summary, rawMessages);

  logger.info('history', '全量压缩完成');
  return result;
}
