import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../utils/config';

const BASE = 'https://discord.com/api/v10';

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

export async function sendFollowup(interactionToken: string, content: string): Promise<void> {
  await axios.patch(
    `${BASE}/webhooks/${config.discord.appId}/${interactionToken}/messages/@original`,
    { content },
    {
      headers: { Authorization: `Bot ${config.discord.botToken}` },
      httpsAgent,
    },
  );
}
