import { MarketplaceBot } from './bot/bot.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('App');

try {
  const bot = new MarketplaceBot();
  logger.info('Бот запущен');
} catch (error) {
  logger.error('Ошибка запуска: ' + error.message);
  process.exit(1);
}