import { startWebhook } from './webhook';
import { startGateway } from './gateway';

startWebhook().catch((err) => {
  console.error('Failed to start webhook server:', err);
  process.exit(1);
});

startGateway();
