import axios from 'axios';
import { config } from '../utils/config';

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
];

async function registerCommands() {
  const url = `${BASE}/applications/${config.discord.appId}/commands`;
  const res = await axios.put(url, commands, {
    headers: { Authorization: `Bot ${config.discord.botToken}` },
  });
  console.log('注册成功：', res.data);
}

registerCommands().catch(err => {
  console.error('注册失败：', err.response?.data ?? err.message);
  process.exit(1);
});
