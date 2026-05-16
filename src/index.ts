import * as readline from 'readline';
import { runAgent } from './agents/executor';
import type OpenAI from 'openai';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ---------------------------------------------------------------------------
// ANSI 颜色
// ---------------------------------------------------------------------------
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
  red:     '\x1b[31m',
};

const paint = (color: string, text: string) => `${color}${text}${c.reset}`;

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(label: string): () => void {
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${paint(c.cyan, FRAMES[i % FRAMES.length])} ${paint(c.dim, label)}`);
    i++;
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K'); // 清除当前行
  };
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const history: Message[] = [];

function askUser() {
  rl.question(`\n${paint(c.green + c.bold, '你')} ${paint(c.gray, '›')} `, async (input) => {
    const text = input.trim();
    if (!text) return askUser();

    if (text === '/exit' || text === '/quit') {
      console.log(paint(c.gray, '\n再见，祝投资顺利 👋\n'));
      rl.close();
      return;
    }

    const stop = startSpinner('正在分析，请稍候…');
    try {
      const reply = await runAgent(text, history);
      stop();
      console.log(`\n${paint(c.cyan + c.bold, '助理')} ${paint(c.gray, '›')}\n`);
      console.log(reply);
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n${paint(c.red, '错误：')}${msg}`);
    }

    askUser();
  });
}

// ---------------------------------------------------------------------------
// 启动：自我介绍
// ---------------------------------------------------------------------------
async function main() {
  console.clear();
  console.log(paint(c.cyan + c.bold, '╔════════════════════════════════╗'));
  console.log(paint(c.cyan + c.bold, '║     AI 基金分析助理  v1.0      ║'));
  console.log(paint(c.cyan + c.bold, '╚════════════════════════════════╝'));
  console.log(paint(c.gray, '  输入 /exit 退出\n'));

  const stop = startSpinner('启动中…');
  try {
    const intro = await runAgent('请简短自我介绍（2-3句话），然后列出5个用户可以问你的典型问题，用编号列表展示。', []);
    stop();
    console.log(`\n${paint(c.cyan + c.bold, '助理')} ${paint(c.gray, '›')}\n`);
    console.log(intro);
    history.push({ role: 'assistant', content: intro });
  } catch {
    stop();
    console.log(paint(c.yellow, '（自我介绍加载失败，请确认 server 和 LLM 配置正确）'));
  }

  askUser();
}

main();
