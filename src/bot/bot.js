import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { config } from '../config/index.js';
import { userService } from '../modules/users/user.service.js';
import { subscriptionService } from '../modules/subscriptions/subscription.service.js';
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
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString()
      });
    });

    if (config.bot.webhookUrl) {
      const webhookPath = `/webhook/${config.bot.token}`;
      this.app.post(webhookPath, (req, res) => {
        this.bot.processUpdate(req.body);
        res.sendStatus(200);
      });
    }
  }

  async setupWebhook() {
    try {
      const webhookUrl = `${config.bot.webhookUrl}/webhook/${config.bot.token}`;
      await this.bot.setWebHook(webhookUrl);
      logger.info(`Webhook установлен: ${webhookUrl}`);
    } catch (error) {
      logger.error('Ошибка webhook: ' + error.message);
    }
  }

  setupHandlers() {
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const username = msg.from.username || msg.from.first_name;
      
      try {
        const { user, isNew } = await userService.registerUser(msg.from.id, username);
        const subInfo = await subscriptionService.getSubscriptionInfo(user.id);
        
        let message = `👋 Привет, ${username}!\n\n`;
        if (isNew) message += `🎉 Добро пожаловать!\n\n`;
        
        message += `📊 Тариф: ${subInfo.type}\n`;
        if (subInfo.type === 'PRO' && subInfo.daysLeft) {
          message += `⏳ Осталось: ${subInfo.daysLeft} дней\n`;
        }
        
        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [[{ text: '💎 Подписка' }]],
            resize_keyboard: true
          }
        });
      } catch (error) {
        await this.bot.sendMessage(chatId, '❌ Ошибка сервера');
      }
    });

    this.bot.onText(/💎 Подписка|\/sub/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        const subInfo = await subscriptionService.getSubscriptionInfo(user.id);
        
        let text = `💎 Подписка\n\nТариф: ${subInfo.type}\n`;
        if (subInfo.type === 'FREE') {
          text += `\n🆓 FREE:\n• 50 заказов/день\n• 1 магазин\n\n💎 PRO:\n• Безлимит\n• Все маркетплейсы`;
        } else {
          text += `\nДо: ${subInfo.endDate?.toLocaleDateString()}\nОсталось: ${subInfo.daysLeft} дн.`;
        }
        
        await this.bot.sendMessage(chatId, text);
      } catch (error) {
        console.error(error);
      }
    });
  }
}
