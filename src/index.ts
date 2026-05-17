import * as readline from 'readline';
import { runAgent } from './agents/executor';
import { loadProfile } from './services/storage';
import { startupSummaryPrompt } from './prompts';
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
  gray:    '\x1b[90m',
  red:     '\x1b[31m',
};
const paint = (color: string, text: string) => `${color}${text}${c.reset}`;
const renderAnsi = (text: string) => text.replace(/\\x1b\[/g, '\x1b[');

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(initialLabel: string) {
  let label = initialLabel;
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${paint(c.cyan, FRAMES[i % FRAMES.length])} ${paint(c.dim, label)}`);
    i++;
  }, 80);
  return {
    update: (next: string) => {
      // 换新步骤时先落一行，让每个步骤独占一行
      process.stdout.write(`\r\x1b[2K${paint(c.gray, '✓')} ${paint(c.dim, label)}\n`);
      label = next;
      i = 0;
    },
    stop: () => { clearInterval(timer); process.stdout.write('\r\x1b[2K'); },
  };
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const history: Message[] = [];

function askUser() {
  rl.question('\n你 › ', async (input) => {
    const text = input.trim();
    if (!text) return askUser();

    // 行尾 \ 续行：继续读取下一行拼接
    if (text.endsWith('\\')) {
      const prefix = text.slice(0, -1) + '\n';
      collectLines(prefix);
      return;
    }

    if (text === '/exit' || text === '/quit') {
      console.log(paint(c.gray, '\n再见，祝投资顺利 👋\n'));
      rl.close();
      return;
    }

    await submit(text);
    askUser();
  });
}

// 续行收集：用户在行尾加 \ 时持续追加
function collectLines(accumulated: string) {
  rl.question('  · ', async (input) => {
    const text = input.trim();
    if (text.endsWith('\\')) {
      collectLines(accumulated + text.slice(0, -1) + '\n');
    } else {
      await submit(accumulated + text);
      askUser();
    }
  });
}

async function submit(text: string) {
  const spinner = startSpinner('思考中…\n');
  try {
    const reply = await runAgent(text, history, (label) => spinner.update(label));
    spinner.stop();
    console.log(`\n${paint(c.cyan + c.bold, '助理')} ${paint(c.gray, '›')}\n`);
    console.log(renderAnsi(reply));
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
  } catch (err: unknown) {
    spinner.stop();
    if (err && typeof err === 'object' && 'response' in err) {
      const e = err as { message: string; response?: { status: number; data: unknown } };
      console.error(`\n${paint(c.red, '错误：')}${e.message}`);
      if (e.response) console.error(paint(c.gray, JSON.stringify(e.response.data, null, 2)));
    } else {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error(`\n${paint(c.red, '错误：')}${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function main() {
  console.clear();
  console.log(paint(c.cyan + c.bold, '╔════════════════════════════════╗'));
  console.log(paint(c.cyan + c.bold, '║     AI 基金分析助理  v1.0      ║'));
  console.log(paint(c.cyan + c.bold, '╚════════════════════════════════╝'));
  console.log(paint(c.gray, '  行尾加 \\ 可续行，/exit 退出\n'));

  const spinner = startSpinner('启动中…');
  try {
    const profile = loadProfile();

    if (profile) {
      const intro = await runAgent(
        startupSummaryPrompt(JSON.stringify(profile, null, 2)),
        [],
        (label) => spinner.update(label),
      );
      spinner.stop();
      console.log(`\n${paint(c.cyan + c.bold, '助理')} ${paint(c.gray, '›')}\n`);
      console.log(renderAnsi(intro));
      history.push({ role: 'assistant', content: intro });
    } else {
      spinner.stop();
      const guide = [
        `${paint(c.cyan + c.bold, '你好！我是你的 AI 基金分析助理')} 👋`,
        '',
        `${paint(c.bold, '还没有持仓记录，可以通过以下方式开始：')}`,
        '',
        `  ${paint(c.cyan, '①')} ${paint(c.bold, '上传截图')}   发送持仓截图路径，自动识别基金信息`,
        `        例：分析持仓 ~/Downloads/screenshot.jpg`,
        '',
        `  ${paint(c.cyan, '②')} ${paint(c.bold, '手动录入')}   直接告诉我持仓情况`,
        `        例：我持有 000001 华夏成长 1万份，成本 1.2 元`,
        '',
        `  ${paint(c.cyan, '③')} ${paint(c.bold, '单只分析')}   查询任意基金的历史表现、经理信息等`,
        `        例：帮我分析一下 110011 这只基金`,
        '',
        paint(c.gray, '  输入后我会自动保存你的持仓和投资偏好，下次启动直接展示摘要。'),
      ].join('\n');
      console.log(`\n${paint(c.cyan + c.bold, '助理')} ${paint(c.gray, '›')}\n`);
      console.log(guide);
      history.push({ role: 'assistant', content: guide });
    }
  } catch {
    spinner.stop();
    console.log(paint(c.yellow, '（启动加载失败，请确认 server 和 LLM 配置正确）'));
  }

  askUser();
}

main();
