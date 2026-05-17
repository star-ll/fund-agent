import axios from 'axios';
import { config } from '../utils/config';
import { redis } from '../services/redis';

const BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const TOKEN_KEY = 'wework:access_token';

async function getAccessToken(): Promise<string> {
  const cached = await redis.get(TOKEN_KEY);
  if (cached) return cached;

  const { data } = await axios.get(`${BASE}/gettoken`, {
    params: { corpid: config.wework.corpId, corpsecret: config.wework.secret },
  });
  if (data.errcode !== 0) throw new Error(`获取 access_token 失败: ${data.errmsg}`);

  await redis.setex(TOKEN_KEY, data.expires_in - 60, data.access_token);
  return data.access_token;
}

export async function sendText(toUser: string, content: string): Promise<void> {
  const token = await getAccessToken();
  const { data } = await axios.post(`${BASE}/message/send?access_token=${token}`, {
    touser: toUser,
    msgtype: 'text',
    agentid: config.wework.agentId,
    text: { content },
    safe: 0,
  });
  if (data.errcode !== 0) throw new Error(`发送消息失败: ${data.errmsg}`);
}
