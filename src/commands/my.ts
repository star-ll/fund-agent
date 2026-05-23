import OpenAI from 'openai';
import { config } from '../utils/config';
import { loadProfileFromDB } from '../services/user';
import { myHoldingsPrompt } from '../prompts';

const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey });

export async function buildMyHoldingsReply(userId: string): Promise<string> {
  const profile = await loadProfileFromDB(userId);

  if (!profile || (profile.holdings.length === 0 && !profile.risk_level)) {
    return '暂无持仓数据，请先通过截图或文字告知我你的持仓情况。';
  }

  const prompt = myHoldingsPrompt(JSON.stringify(profile, null, 2));

  const response = await client.chat.completions.create({
    model: config.llm.model,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.choices[0].message.content ?? '获取持仓信息失败，请稍后重试。';
}
