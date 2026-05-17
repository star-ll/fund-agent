import Redis from 'ioredis';
import { config } from '../utils/config';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  lazyConnect: true,
});

redis.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
    console.error('[Redis]', err.message);
  }
});
