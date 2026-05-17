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
  mysql: {
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: parseInt(process.env.MYSQL_PORT ?? '3306'),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'ai_jijin',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  discord: {
    publicKey: process.env.DISCORD_PUBLIC_KEY ?? '',
    appId: process.env.DISCORD_APP_ID ?? '',
    botToken: process.env.DISCORD_BOT_TOKEN ?? '',
  },
  port: parseInt(process.env.PORT ?? '3000'),
};
