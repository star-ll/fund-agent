import * as fs from 'fs';
import * as path from 'path';

function load(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

const dir = __dirname;

export const coreSystemPrompt = load(path.join(dir, 'system.md'));
export const portfolioAnalysisPrompt = load(path.join(dir, 'portfolio.md'));
export const startupSummaryPrompt = (profile: string) =>
  load(path.join(dir, 'startup-summary.md')).replace('{{profile}}', profile);
export const myHoldingsPrompt = (profile: string) =>
  load(path.join(dir, 'my-holdings.md')).replace('{{profile}}', profile);

export function buildSystemPrompt(outputFormatFile: string): string {
  const extension = load(outputFormatFile);
  return `${coreSystemPrompt}\n${extension}`;
}
