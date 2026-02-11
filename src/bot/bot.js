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
    // 1. Обработка текстовых сообщений (API ключи и т.д.)
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

    // 4. Команда /mystores (список магазинов)
    this.bot.onText(/\/mystores|Мои магазины/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        const { marketplaceService } = await import('../modules/marketplaces/marketplace.service.js');
        const stores = await marketplaceService.getByUser(user.id);
        
        if (stores.length === 0) {
          return this.bot.sendMessage(chatId,
            '🏪 У вас пока нет добавленных магазинов.\n\n' +
            'Добавьте первый: /addmarket',
            { parse_mode: 'HTML' }
          );
        }
        
        let message = '🏪 <b>Ваши магазины:</b>\n\n';
        const keyboard = [];
        
        stores.forEach((store, index) => {
          const status = store.isActive ? '✅' : '❌';
          message += `${index + 1}. ${status} <b>${store.name}</b>\n`;
          message += `   Добавлен: ${store.createdAt.toLocaleDateString('ru-RU')}\n\n`;
          
          keyboard.push([{ 
            text: `🗑 Удалить ${store.name}`, 
            callback_data: `delete_store_${store.id}` 
          }]);
        });
        
        message += `\n💡 Всего: ${stores.length} магазин(ов)`;
        
        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      } catch (err) {
        logger.error('Mystores error: ' + err.message);
        await this.bot.sendMessage(chatId, '❌ Ошибка получения списка');
      }
    });

    // 5. Команда /sync (синхронизация заказов) - НОВОЕ
    this.bot.onText(/\/sync|Синхронизировать заказы/, async (msg) => {
      const chatId = msg.chat.id;
      
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        
        if (!user.marketplaces || user.marketplaces.length === 0) {
          return this.bot.sendMessage(chatId,
            '❌ У вас нет добавленных магазинов.\n\n' +
            'Добавьте магазин: /addmarket'
          );
        }

        await this.bot.sendMessage(chatId, '🔄 Начинаю синхронизацию...');
        
        const { orderService } = await import('../modules/orders/order.service.js');
        let totalSynced = 0;
        
        // Синхронизируем все магазины
        for (const marketplace of user.marketplaces) {
          try {
            const result = await orderService.syncOrders(user.id, marketplace.id);
            totalSynced += result.saved;
          } catch (err) {
            logger.error(`Sync error for ${marketplace.name}:`, err.message);
          }
        }
        
        await this.bot.sendMessage(chatId,
          `✅ Синхронизация завершена!\n\n` +
          `📦 Загружено заказов: ${totalSynced}\n\n` +
          `Просмотреть: /orders`,
          { parse_mode: 'HTML' }
        );
        
      } catch (err) {
        logger.error('Sync command error:', err.message);
        await this.bot.sendMessage(chatId, '❌ Ошибка синхронизации: ' + err.message);
      }
    });

    // 6. Команда /orders (список заказов / 📊 Мои заказы) - НОВОЕ
    this.bot.onText(/\/orders|📊 Мои заказы/, async (msg) => {
      const chatId = msg.chat.id;
      
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        const { orderService } = await import('../modules/orders/order.service.js');
        const orders = await orderService.getOrdersByUser(user.id);
        
        if (orders.length === 0) {
          return this.bot.sendMessage(chatId,
            '📭 У вас пока нет заказов.\n\n' +
            'Загрузите заказы: /sync',
            { parse_mode: 'HTML' }
          );
        }
        
        let message = '📊 <b>Последние заказы:</b>\n\n';
        
        orders.slice(0, 10).forEach((order, index) => {
          const data = order.data;
          message += `${index + 1}. <b>#${order.externalId}</b> | ${order.marketplace.name}\n`;
          message += `   Статус: ${order.status}\n`;
          message += `   Сумма: ${data.totalAmount || 'N/A'} сум\n`;
          message += `   Дата: ${new Date(order.createdAt).toLocaleDateString('ru-RU')}\n\n`;
        });
        
        if (orders.length > 10) {
          message += `\n💡 И ещё ${orders.length - 10} заказов...`;
        }
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        
      } catch (err) {
        logger.error('Orders command error:', err.message);
        await this.bot.sendMessage(chatId, '❌ Ошибка получения заказов');
      }
    });

    // 7. Команда /sub (Подписка)
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

        // 8. Команда /admin (только для админов)
    this.bot.onText(/\/admin/, async (msg) => {
      const chatId = msg.chat.id;
      
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        
        if (!await userService.isAdmin(user.id)) {
          return this.bot.sendMessage(chatId, '⛔ У вас нет доступа к админ-панели');
        }

        const stats = await userService.getUserStats();
        
        let message = '🔧 <b>Админ панель</b>\n\n';
        message += `👥 Всего пользователей: ${stats.total}\n`;
        message += `💎 PRO: ${stats.pro}\n`;
        message += `🆓 FREE: ${stats.free}\n\n`;
        message += 'Выберите действие:';

        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👥 Список пользователей', callback_data: 'admin_users' }],
              [{ text: '⚡ Выдать PRO', callback_data: 'admin_grant_pro' }]
            ]
          }
        });
      } catch (err) {
        logger.error('Admin error: ' + err.message);
        await this.bot.sendMessage(chatId, '❌ Ошибка админ-панели');
      }
    });
    // 9. Обработка inline кнопок (callback_query)
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const data = query.data;
      
      // Выбор маркетплейса для добавления
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
      
      // Удаление магазина
      if (data.startsWith('delete_store_')) {
        const storeId = data.replace('delete_store_', '');
        await this.bot.answerCallbackQuery(query.id);
        
        try {
          const user = await userService.getUserByTelegramId(query.from.id);
          const { marketplaceService } = await import('../modules/marketplaces/marketplace.service.js');
          await marketplaceService.delete(storeId, user.id);
          
          await this.bot.sendMessage(chatId, '✅ Магазин успешно удален!\n\nОбновите список: /mystores');
        } catch (err) {
          logger.error('Delete store error: ' + err.message);
          await this.bot.sendMessage(chatId, '❌ Ошибка удаления магазина');
        }
      }
    });
  }
}

