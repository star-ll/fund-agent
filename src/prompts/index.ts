import * as fs from 'fs';
import * as path from 'path';

function load(file: string): string {
  return fs.readFileSync(path.join(__dirname, file), 'utf-8');
}

export const systemPrompt = load('system.md');
export const portfolioAnalysisPrompt = load('portfolio.md');
export const startupSummaryPrompt = (profile: string) =>
  load('startup-summary.md').replace('{{profile}}', profile);
