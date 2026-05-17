import { startWebhook } from './webhook';

startWebhook().catch((err) => {
  console.error('Failed to start webhook server:', err);
  process.exit(1);
});
