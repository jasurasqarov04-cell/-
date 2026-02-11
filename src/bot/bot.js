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
    // 1. Обработка текстовых сообщений (API ключи, админ команды и т.д.)
    this.bot.on('message', async (msg) => {
      if (!msg.text || msg.text.startsWith('/')) return;
      
      const chatId = msg.chat.id;
      const tempData = await userService.getTempData(msg.from.id);
      
      // Выдача PRO админом
      if (tempData?.action === 'grant_pro') {
        const [targetId, days] = msg.text.split(' ');
        
        if (!targetId || !days || isNaN(days)) {
          return this.bot.sendMessage(chatId, '❌ Неверный формат. Пример: 123456789 30');
        }

        try {
          const targetUser = await userService.getUserByTelegramId(targetId);
          if (!targetUser) {
            return this.bot.sendMessage(chatId, '❌ Пользователь не найден');
          }

          await subscriptionService.grantPro(targetUser.id, parseInt(days));
          await userService.clearTempData(msg.from.id);
          
          await this.bot.sendMessage(chatId, 
            `✅ PRO выдан пользователю @${targetUser.username || targetId} на ${days} дней!`
          );
          
          // Уведомляем пользователя
          try {
            await this.bot.sendMessage(targetId, 
              `🎉 Вам выдана PRO подписка на ${days} дней!\n\n` +
              `Теперь у вас:\n` +
              `✅ Безлимитные заказы\n` +
              `✅ Все маркетплейсы\n` +
              `✅ Приоритетная поддержка`
            );
          } catch (notifyErr) {
            logger.error('Failed to notify user: ' + notifyErr.message);
          }
        } catch (err) {
          await this.bot.sendMessage(chatId, '❌ Ошибка выдачи PRO: ' + err.message);
        }
        return;
      }
      
      // Добавление API ключа для магазина
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
        
        // Проверяем админ ли для добавления кнопки админки (через ADMIN_IDS в .env)
        const isAdmin = config.bot.adminIds.includes(String(msg.from.id));
        const keyboard = [
          [{ text: '🏪 Добавить магазин' }, { text: '📊 Мои заказы' }],
          [{ text: '💎 Подписка' }]
        ];
        
        // Добавляем кнопку админки если админ
        if (isAdmin) {
          keyboard.push([{ text: '🔧 Админ панель' }]);
        }
        
        await this.bot.sendMessage(chatId, message, {
          reply_markup: {
            keyboard: keyboard,
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

    // 5. Команда /sync (синхронизация заказов)
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

    // 6. Команда /orders (список заказов / 📊 Мои заказы)
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

    // 7. Команда /sub (Подписка) - УЛУЧШЕННАЯ
    this.bot.onText(/Подписка|\/sub/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const user = await userService.getUserByTelegramId(msg.from.id);
        const info = await subscriptionService.getSubscriptionInfo(user.id);
        
        let message = '💎 <b>Управление подпиской</b>\n\n';
        message += `📊 Ваш текущий тариф: <b>${info.type}</b>\n`;
        
        if (info.type === 'PRO' && info.daysLeft) {
          message += `⏳ Осталось дней: ${info.daysLeft}\n`;
          message += `📅 Действует до: ${info.endDate?.toLocaleDateString('ru-RU')}\n\n`;
        } else {
          message += '\n';
        }

        message += '<b>🆓 FREE (Бесплатно):</b>\n';
        message += '• 1 магазин\n';
        message += '• 50 заказов в день\n';
        message += '• Базовая статистика\n\n';

        message += '<b>💎 PRO ($9/мес):</b>\n';
        message += '• Безлимит магазинов\n';
        message += '• Безлимит заказов\n';
        message += '• Приоритетная поддержка\n';
        message += '• API доступ\n\n';

        const keyboard = {
          inline_keyboard: [
            [{ text: '🎁 Пробный PRO (1 день)', callback_data: 'trial_pro' }],
            [{ text: '💳 Купить PRO', callback_data: 'buy_pro' }]
          ]
        };

        // Если админ, добавляем кнопку выдачи
        if (config.bot.adminIds.includes(String(msg.from.id))) {
          keyboard.inline_keyboard.push([{ text: '⚡ Выдать PRO (админ)', callback_data: 'admin_grant_pro' }]);
        }

        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
      } catch (err) {
        logger.error('Sub error: ' + err.message);
      }
    });

    // 8. Команда /buy (Покупка PRO) - ИСПРАВЛЕННАЯ (убран @admin)
    this.bot.onText(/\/buy|Купить PRO/, async (msg) => {
      const chatId = msg.chat.id;
      
      const message = '💳 <b>Выберите срок подписки PRO:</b>\n\n' +
        '<b>7 дней</b> — $3\n' +
        '<b>30 дней</b> — $9 (выгода 25%)\n' +
        '<b>90 дней</b> — $24 (выгода 33%)\n\n' +
        '💡 После выбора срока администратор получит уведомление и свяжется с вами для оплаты.';

      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '7 дней — $3', callback_data: 'buy_pro_7' }],
            [{ text: '30 дней — $9', callback_data: 'buy_pro_30' }],
            [{ text: '90 дней — $24', callback_data: 'buy_pro_90' }]
          ]
        }
      });
    });

    // 9. Команда /admin (Админ панель)
    this.bot.onText(/\/admin|🔧 Админ панель/, async (msg) => {
      const chatId = msg.chat.id;
      
      // Проверка через ADMIN_IDS в .env (а не через базу данных)
      if (!config.bot.adminIds.includes(String(msg.from.id))) {
        return this.bot.sendMessage(chatId, '⛔ У вас нет доступа к админ-панели');
      }

      try {
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

    // 10. Команда /grant (быстрая выдача PRO админом)
    this.bot.onText(/\/grant (\d+) (\d+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      
      // Проверка админ
      if (!config.bot.adminIds.includes(String(msg.from.id))) {
        return;
      }
      
      const targetId = match[1];
      const days = parseInt(match[2]);
      
      try {
        const targetUser = await userService.getUserByTelegramId(targetId);
        if (!targetUser) {
          return this.bot.sendMessage(chatId, '❌ Пользователь не найден');
        }
        
        await subscriptionService.grantPro(targetUser.id, days);
        
        await this.bot.sendMessage(chatId, 
          `✅ PRO выдан!\n\nПользователь: @${targetUser.username || targetId}\nСрок: ${days} дней`
        );
        
        // Уведомляем пользователя
        await this.bot.sendMessage(targetId,
          `🎉 <b>Вам выдан доступ PRO!</b>\n\n` +
          `Срок: ${days} дней\n` +
          `Все функции разблокированы.\n\n` +
          `Управление: /sub`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        logger.error('Grant error:', err.message);
        await this.bot.sendMessage(chatId, '❌ Ошибка выдачи');
      }
    });

    // 11. Обработка inline кнопок (callback_query) - ИСПРАВЛЕННАЯ
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
      
      // Админ: список пользователей
      if (data === 'admin_users') {
        await this.bot.answerCallbackQuery(query.id);
        
        try {
          const users = await userService.getAllUsers();
          let message = '👥 <b>Пользователи (последние 50):</b>\n\n';
          
          users.forEach((u, i) => {
            const sub = u.subscriptions[0]?.type || 'FREE';
            const date = u.createdAt.toLocaleDateString('ru-RU');
            message += `${i+1}. @${u.username || 'нет'} | ${sub} | Магазинов: ${u._count.marketplaces} | ${date}\n`;
          });
          
          await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error('Admin users error:', err.message);
          await this.bot.sendMessage(chatId, '❌ Ошибка получения списка');
        }
      }

      // Админ: выдать PRO (запрос ID)
      if (data === 'admin_grant_pro') {
        await this.bot.answerCallbackQuery(query.id);
        await userService.setTempData(query.from.id, { action: 'grant_pro' });
        await this.bot.sendMessage(chatId, 
          '⚡ Введите Telegram ID пользователя и количество дней через пробел:\n\n' +
          'Пример: 123456789 30',
          { parse_mode: 'HTML' }
        );
      }

      // Пробный PRO (1 день) - автовыдача
      if (data === 'trial_pro') {
        await this.bot.answerCallbackQuery(query.id);
        
        try {
          const user = await userService.getUserByTelegramId(query.from.id);
          
          // Проверяем не брал ли уже пробный
          const hasPro = await subscriptionService.hasActivePro(user.id);
          if (hasPro) {
            return this.bot.sendMessage(chatId, '❌ У вас уже активна PRO подписка!');
          }

          // Выдаем пробный на 1 день
          await subscriptionService.grantPro(user.id, 1);
          
          await this.bot.sendMessage(chatId,
            '🎉 <b>Пробный PRO активирован!</b>\n\n' +
            '✅ Доступен на 1 день\n' +
            '✅ Все функции PRO разблокированы\n\n' +
            'После окончания можно купить полную версию: /buy',
            { parse_mode: 'HTML' }
          );
          
        } catch (err) {
          logger.error('Trial PRO error:', err.message);
          await this.bot.sendMessage(chatId, '❌ Ошибка активации пробного периода');
        }
      }

      // ИСПРАВЛЕНО: Обработка кнопки "Купить PRO" (без указания срока)
      if (data === 'buy_pro') {
        await this.bot.answerCallbackQuery(query.id);
        
        const message = '💳 <b>Выберите срок подписки PRO:</b>\n\n' +
          '<b>7 дней</b> — $3\n' +
          '<b>30 дней</b> — $9 (выгода 25%)\n' +
          '<b>90 дней</b> — $24 (выгода 33%)\n\n' +
          '💡 После выбора администратор получит уведомление и свяжется с вами для оплаты.';

        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '7 дней — $3', callback_data: 'buy_pro_7' }],
              [{ text: '30 дней — $9', callback_data: 'buy_pro_30' }],
              [{ text: '90 дней — $24', callback_data: 'buy_pro_90' }]
            ]
          }
        });
      }

      // Запрос на покупку PRO (конкретный срок) - ИСПРАВЛЕННЫЙ ТЕКСТ (убран @admin)
      if (data.startsWith('buy_pro_') && data !== 'buy_pro') {
        const days = data.replace('buy_pro_', '');
        await this.bot.answerCallbackQuery(query.id);
        
        // Отправляем уведомление админу
        const user = await userService.getUserByTelegramId(query.from.id);
        const adminMsg = `💳 <b>Новый запрос на PRO!</b>\n\n` +
          `Пользователь: @${user.username || user.telegramId}\n` +
          `ID: ${user.telegramId}\n` +
          `Тариф: ${days} дней\n\n` +
          `Для выдачи отправь:\n/grant ${user.telegramId} ${days}`;
        
        // Отправляем всем админам
        for (const adminId of config.bot.adminIds) {
          try {
            await this.bot.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' });
          } catch (err) {
            logger.error('Failed to notify admin:', err.message);
          }
        }
        
        await this.bot.sendMessage(chatId,
          '✅ <b>Заявка отправлена!</b>\n\n' +
          'Администратор получил уведомление и скоро активирует ваш PRO доступ.\n\n' +
          '⏳ Обычно это занимает 10-30 минут.',
          { parse_mode: 'HTML' }
        );
      }
    });
  }
}
