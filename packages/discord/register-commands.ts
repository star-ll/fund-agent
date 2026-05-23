import axios from 'axios';
import { config } from '../../src/utils/config';

const BASE = 'https://discord.com/api/v10';

const commands = [
  {
    name: 'ask',
    description: '向基金助手提问',
    options: [
      {
        name: 'question',
        description: '你的问题，例如：000001基金怎么样',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'new',
    description: '开启新对话，清除之前的记忆',
  },
  {
    name: 'my',
    description: '查看我的持仓信息',
  },
];

async function registerCommands() {
  const url = `${BASE}/applications/${config.discord.appId}/commands`;
  const res = await axios.put(url, commands, {
    headers: { Authorization: `Bot ${config.discord.botToken}` },
  });
  console.log('注册成功：', res.data);
}

registerCommands().catch(err => {
  console.error('注册失败：');
  console.error('status:', err.response?.status);
  console.error('data:', JSON.stringify(err.response?.data, null, 2));
  console.error('message:', err.message);
  console.error('code:', err.code);
  console.error('appId:', config.discord.appId || '(空)');
  console.error('botToken:', config.discord.botToken ? config.discord.botToken.slice(0, 10) + '…' : '(空)');
  process.exit(1);
});
