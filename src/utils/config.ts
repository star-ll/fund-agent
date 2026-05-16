import dotenv from 'dotenv';
dotenv.config();

export const config = {
  llm: {
    baseURL: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o',
  },
  akshare: {
    baseURL: process.env.AKSHARE_BASE_URL ?? 'http://localhost:8080',
  },
};
