import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

// Проверка обязательных переменных
const required = ['BOT_TOKEN', 'ENCRYPTION_KEY'];
for (const env of required) {
  if (!process.env[env]) {
    console.error(`❌ Отсутствует переменная окружения: ${env}`);
    process.exit(1);
  }
}

export const config = {
  bot: {
    token: process.env.BOT_TOKEN,
    adminIds: process.env.ADMIN_IDS?.split(',').map(id => id.trim()) || [],
    webhookUrl: process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL || null,
    port: parseInt(process.env.PORT) || 3000,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY,
  },
  app: {
    env: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
  },
};