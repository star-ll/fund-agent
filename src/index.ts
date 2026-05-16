import * as readline from 'readline';
import { runAgent } from './agents/executor';
import type OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const history: Message[] = [];

function prompt() {
  rl.question('\n你: ', async (input) => {
    const text = input.trim();
    if (!text) return prompt();
    if (text === '/exit' || text === '/quit') {
      console.log('bye！');
      rl.close();
      return;
    }

    try {
      process.stdout.write('\nAgent: ...\n');
      const reply = await runAgent(text, history);
      console.log(reply);

      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      const message = err instanceof Error ? err.message : err
      console.error(err);
      console.error('error：',message || '异常错误' );
    }

    prompt();
  });
}

console.log('=== AI 基金分析助理 ===');
console.log('输入 /exit 退出\n');
prompt();
