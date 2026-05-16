import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';

export async function extractText(imagePath: string): Promise<string> {
  const resolved = imagePath.startsWith('~')
    ? path.join(process.env.HOME ?? '', imagePath.slice(1))
    : path.resolve(imagePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`图片文件不存在：${resolved}`);
  }

  const worker = await createWorker('chi_sim+eng');
  try {
    const { data } = await worker.recognize(resolved);
    return data.text.trim();
  } finally {
    await worker.terminate();
  }
}
