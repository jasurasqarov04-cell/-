import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { config } from '../config/index.js';
import { userService } from '../modules/users/user.service.js';
import { subscriptionService } from '../modules/subscriptions/subscription.service.js';
import { encrypt } from '../utils/encryption.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Bot');

export class MarketplaceBot {
  constructor() {
    this.app = express();
    this.setupExpress();
    
    const port = config.bot.port;
    
    if (config.bot.webhookUrl) {
      this.bot = new TelegramBot(config.bot.token);
      this.setupWebhook();
      logger.info('Webhook режим');
    } else {
      this.bot = new TelegramBot(config.bot.token, { polling: true });
      logger.info('Polling режим');
    }
    
    this.setupHandlers();
    
    this.app.listen(port, '0.0.0.0', () => {
      logger.info(`Сервер запущен на порту ${port}`);
    });
  }

  setupExpress() {
    this.app.use(express.json());
    
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    if (config.bot.webhookUrl) {
      const path = `/webhook/${config.bot.token}`;
      this.app.post(path, (req, res) => {
        this.bot.processUpdate(req.body);
        res.sendStatus(200);
      });
      logger.info(`Webhook path: ${path}`);
    }
  }

  async setupWebhook() {
    try {
      const url = `${config.bot.webhookUrl}/webhook/${config.bot.token}`;
      await this.bot.setWebHook(url);
      logger.info(`Webhook установлен: ${url}`);
    } catch (err) {
      logger.error('Ошибка webhook: ' + err.message);
    }
  }

  setupHandlers() {
    // 1. Обработка текстовых сообщений (API ключи и т.д.) - в начале!
    this.bot.on('message', async (msg) => {
      if (!msg.text || msg.text.startsWith('/')) return;
      
      const chatId = msg.chat.id;
      const tempData = await userService.getTempData(msg.from.id);
      
      if (tempData?.action === 'add_api') {
        const [apiKey, apiSecret] = msg.text.split('|').map(s => s.trim());
        
        if (!apiKey) {
          return this.bot.sendMessage(chatId, '❌ API ключ не может быть пустым');
        }

        try {
          const user = await userService.getUserByTelegramId(msg.from.id);
          
          const encryptedKey = encrypt(apiKey);
          const encryptedSecret = apiSecret ? encrypt(apiSecret) : null;
          
          const { marketplaceService } = await import('../modules/marketplaces/marketplace.service.js');
          await marketplaceService.create({
            userId: user.id,
            name: tempData.market,
            apiKey: encryptedKey,
            apiSecret: encryptedSecret
          });
          
          await userService.clearTempData(msg.from.id);
          
          await this.bot.sendMessage(chatId,
            `✅ Магазин ${tempData.market} успешно добавлен!\n\n` +
            `Теперь вы можете:\n` +
            `/mystores — список магазинов\n` +
            `/sync — синхронизировать заказы`,
            { parse_mode: 'HTML' }
          );
          
        } catch (err) {
          logger.error('Save marketplace error: ' + err.message);
          await this.bot.sendMessage(chatId, '❌ Ошибка сохранения: ' + err.message);
        }
      }
    });

    // 2. Команда /start
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const username = msg.from.username || msg.from.first_name;
      
      try {
        const { user, isNew } = await userService.registerUser(msg.from.id, username);
        const subInfo = await subscriptionService.getSubscriptionInfo(user.id);
        
        let message = `Привет, ${username}!\n\n`;
        if (isNew) message += `Добро пожаловать!\n\n`;
        
        message += `Тариф: ${subInfo.type}\n`;
        if (subInfo.type === 'PRO' && subInfo.daysLeft) {
          message += `Осталось: ${subInfo.daysLeft} дней\n`;
        }
        
        await this.bot.sendMessage(chatId, message, {
          reply_markup: {
            keyboard: [
              [{ text: '🏪 Добавить магазин' }, { text: '📊 Мои заказы' }],
              [{ text: '💎 Подписка' }]
            ],
            resize_keyboard: true
          }
        });
      } catch (err) {
        logger.error('Start error: ' + err.message);
        await this.bot.sendMessage(chatId, 'Ошибка сервера: ' + err.message);
      }
    });

    // 3. Команда /addmarket (или кнопка)
    this.bot.onText(/\/addmarket|Добавить магазин/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        
        const count = user.marketplaces?.length || 0;
        const hasPro = await subscriptionService.hasActivePro(user.id);
        
        if (!hasPro && count >= 1) {
          return this.bot.sendMessage(chatId, 
            '❌ На бесплатном тарифе можно добавить только 1 магазин.\n\n' +
            '💎 Обновитесь до PRO для безлимитного количества.',
            { parse_mode: 'HTML' }
          );
        }

        await this.bot.sendMessage(chatId, 
          '🏪 Выберите маркетплейс:',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🟣 Uzum', callback_data: 'market_uzum' }],
                [{ text: '🔵 Wildberries', callback_data: 'market_wb' }],
                [{ text: '🟠 Ozon', callback_data: 'market_ozon' }]
              ]
            }
          }
        );
      } catch (err) {
        logger.error('Addmarket error: ' + err.message);
        await this.bot.sendMessage(chatId, '❌ Ошибка сервера');
      }
    });

    // 4. Команда /sub (Подписка)
    this.bot.onText(/Подписка|\/sub/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        const info = await subscriptionService.getSubscriptionInfo(user.id);
        
        let text = `Подписка: ${info.type}\n`;
        if (info.type === 'FREE') {
          text += '\nFREE: 50 заказов/день\nPRO: безлимит';
        } else {
          text += `\nДо: ${info.endDate?.toLocaleDateString()}`;
        }
        
        await this.bot.sendMessage(chatId, text);
      } catch (err) {
        logger.error('Sub error: ' + err.message);
      }
    });

    // 5. Обработка inline кнопок (callback_query)
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const data = query.data;
      
      if (data.startsWith('market_')) {
        const market = data.replace('market_', '').toUpperCase();
        await this.bot.answerCallbackQuery(query.id);
        
        await userService.setTempData(query.from.id, { action: 'add_api', market });
        
        await this.bot.sendMessage(chatId,
          `🔑 Введите API ключ для ${market}:\n\n` +
          `Формат: api_key|api_secret\n` +
          `Пример: 123456789|secret123`,
          { parse_mode: 'HTML' }
        );
      }
    });
  }
}
