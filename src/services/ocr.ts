import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import FormData from 'form-data';
import axios from 'axios';
import { config } from '../utils/config';

// OCR 单独用更长超时（大图分段识别可能需要较长时间）
const ocrClient = axios.create({
  baseURL: config.akshare.baseURL,
  timeout: 300000,
});

export async function extractText(imagePath: string): Promise<string> {
  const resolved = imagePath.startsWith('~')
    ? path.join(process.env.HOME ?? os.homedir(), imagePath.slice(1))
    : path.resolve(imagePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`图片文件不存在：${resolved}`);
  }

  const form = new FormData();
  form.append('file', fs.createReadStream(resolved), {
    filename: path.basename(resolved),
    contentType: resolved.endsWith('.png') ? 'image/png' : 'image/jpeg',
  });

  try {
    const { data } = await ocrClient.post<{ text: string }>('/ocr', form, {
      headers: form.getHeaders(),
    });
    return data.text;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ECONNREFUSED' || err instanceof AggregateError) {
      throw new Error('无法连接到 akshare 服务，请先运行 npm run server');
    }
    throw err;
  }
}
