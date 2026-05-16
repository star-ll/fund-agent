import * as readline from 'readline';
import stringWidth from 'string-width';
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
    update: (next: string) => { label = next; },
    stop: () => { clearInterval(timer); process.stdout.write('\r\x1b[2K'); },
  };
}

// ---------------------------------------------------------------------------
// 多行输入（raw mode）
// ---------------------------------------------------------------------------
const history: Message[] = [];
let isProcessing = false;
let inputLines: string[] = [''];
let isPasting = false; // bracketed paste mode 状态

const PROMPT_FIRST = () => `\n${paint(c.green + c.bold, '你')} ${paint(c.gray, '›')} `;
const PROMPT_CONT  = () => `${paint(c.gray, '  · ')}`;

function showInputPrompt() {
  inputLines = [''];
  process.stdout.write(PROMPT_FIRST());
}

async function handleSubmit(rawText: string) {
  const text = rawText.trim();
  if (!text) { showInputPrompt(); return; }

  if (text === '/exit' || text === '/quit') {
    console.log(paint(c.gray, '\n再见，祝投资顺利 👋\n'));
    process.exit(0);
  }

  isProcessing = true;
  const spinner = startSpinner('思考中…');
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
  isProcessing = false;
  showInputPrompt();
}

function setupInput() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    // 启用 Bracketed Paste Mode：粘贴内容被 \x1b[200~ ... \x1b[201~ 包裹
    process.stdout.write('\x1b[?2004h');
    process.on('exit', () => process.stdout.write('\x1b[?2004l'));
  }

  process.stdin.on('keypress', async (_char: string, key: {
    name: string; ctrl: boolean; shift: boolean; meta: boolean; sequence: string;
  }) => {
    if (!key) return;

    // Ctrl+C / Ctrl+D → 退出
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      console.log(paint(c.gray, '\n再见，祝投资顺利 👋\n'));
      process.exit(0);
    }

    // 处理中忽略输入
    if (isProcessing) return;

    // 粘贴开始标记
    if (key.sequence === '\x1b[200~') { isPasting = true; return; }
    // 粘贴结束标记
    if (key.sequence === '\x1b[201~') { isPasting = false; return; }

    // Enter → 粘贴中当换行，否则提交
    if (key.name === 'return' && !key.shift) {
      if (isPasting) {
        inputLines.push('');
        process.stdout.write('\n' + PROMPT_CONT());
      } else {
        const text = inputLines.join('\n');
        process.stdout.write('\n');
        inputLines = [''];
        await handleSubmit(text);
      }
      return;
    }

    // Shift+Enter（部分终端支持）或 Ctrl+J → 换行继续输入
    if ((key.name === 'return' && key.shift) || (key.ctrl && key.name === 'j') || key.sequence === '\n') {
      inputLines.push('');
      process.stdout.write('\n' + PROMPT_CONT());
      return;
    }

    // Backspace
    if (key.name === 'backspace') {
      const last = inputLines[inputLines.length - 1];
      if (last.length > 0) {
        // 取最后一个 Unicode 字符（处理 surrogate pairs）
        const lastChar = [...last].slice(-1)[0];
        const colWidth = stringWidth(lastChar);
        inputLines[inputLines.length - 1] = [...last].slice(0, -1).join('');
        process.stdout.write('\b \b'.repeat(colWidth));
      } else if (inputLines.length > 1) {
        inputLines.pop();
        const prev = inputLines[inputLines.length - 1];
        process.stdout.write(
          '\x1b[1A' +
          '\x1b[2K' +
          PROMPT_CONT() + prev
        );
      }
      return;
    }

    // 普通字符
    if (_char && !key.ctrl && !key.meta) {
      inputLines[inputLines.length - 1] += _char;
      process.stdout.write(_char);
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function main() {
  console.clear();
  console.log(paint(c.cyan + c.bold, '╔════════════════════════════════╗'));
  console.log(paint(c.cyan + c.bold, '║     AI 基金分析助理  v1.0      ║'));
  console.log(paint(c.cyan + c.bold, '╚════════════════════════════════╝'));
  console.log(paint(c.gray, '  Ctrl+J 换行，Enter 发送，/exit 退出\n'));

  setupInput();
  isProcessing = true; // 启动时暂时锁定输入

  const spinner = startSpinner('启动中…');
  try {
    const profile = loadProfile();
    const initPrompt = profile
      ? startupSummaryPrompt(JSON.stringify(profile, null, 2))
      : '请简短自我介绍（2-3句话），并告知用户可以提供持仓信息或截图来开始分析，列出3个典型使用场景。';

    const intro = await runAgent(initPrompt, [], (label) => spinner.update(label));
    spinner.stop();
    console.log(`\n${paint(c.cyan + c.bold, '助理')} ${paint(c.gray, '›')}\n`);
    console.log(renderAnsi(intro));
    history.push({ role: 'assistant', content: intro });
  } catch {
    spinner.stop();
    console.log(paint(c.yellow, '（启动加载失败，请确认 server 和 LLM 配置正确）'));
  }

  isProcessing = false;
  showInputPrompt();
}

main();
