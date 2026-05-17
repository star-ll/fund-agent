import axios from 'axios';
import { config } from '../utils/config';

const BASE = 'https://discord.com/api/v10';

export async function sendFollowup(interactionToken: string, content: string): Promise<void> {
  await axios.patch(
    `${BASE}/webhooks/${config.discord.appId}/${interactionToken}/messages/@original`,
    { content },
    { headers: { Authorization: `Bot ${config.discord.botToken}` } },
  );
}
