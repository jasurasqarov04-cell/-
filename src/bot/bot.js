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

      // ОТЗЫВ PRO (ввод ID для отзыва)
      if (tempData?.action === 'revoke_pro') {
        const targetId = msg.text.trim();
        
        try {
          const targetUser = await userService.getUserByTelegramId(targetId);
          if (!targetUser) {
            return this.bot.sendMessage(chatId, '❌ Пользователь не найден');
          }

          // Проверяем есть ли активная подписка
          const hasPro = await subscriptionService.hasActivePro(targetUser.id);
          if (!hasPro) {
            return this.bot.sendMessage(chatId, '❌ У пользователя нет активной PRO подписки');
          }

          await subscriptionService.revokePro(targetUser.id);
          await userService.clearTempData(msg.from.id);
          
          await this.bot.sendMessage(chatId, 
            `✅ PRO отозван у пользователя @${targetUser.username || targetId}`
          );
          
          // Уведомляем пользователя
          try {
            await this.bot.sendMessage(targetId, 
              `⚠️ <b>Ваш PRO доступ деактивирован</b>\n\n` +
              `Ваш тариф изменен на FREE.\n` +
              `Ограничения:\n` +
              `• Макс. 1 магазин\n` +
              `• 50 заказов в день\n\n` +
              `Для возобновления: /sub`,
              { parse_mode: 'HTML' }
            );
          } catch (notifyErr) {
            logger.error('Failed to notify user about revoke: ' + notifyErr.message);
          }
        } catch (err) {
          logger.error('Revoke error:', err);
          await this.bot.sendMessage(chatId, '❌ Ошибка отзыва PRO: ' + err.message);
        }
        return;
      }

      // РАССЫЛКА: Ввод текста сообщения
      if (tempData?.action === 'broadcast_text') {
        const broadcastText = msg.text;
        
        // Сохраняем текст и ждем фото (или подтверждение без фото)
        await userService.setTempData(msg.from.id, { 
          action: 'broadcast_photo', 
          text: broadcastText 
        });
        
        const confirmKeyboard = {
          inline_keyboard: [
            [{ text: '📷 Прикрепить фото', callback_data: 'broadcast_attach_photo' }],
            [{ text: '▶️ Отправить без фото', callback_data: 'broadcast_send_text_only' }],
            [{ text: '❌ Отмена', callback_data: 'broadcast_cancel' }]
          ]
        };
        
        await this.bot.sendMessage(chatId,
          `📝 <b>Текст рассылки:</b>\n\n${broadcastText}\n\n` +
          `Хотите добавить изображение или отправить только текст?`,
          { parse_mode: 'HTML', reply_markup: confirmKeyboard }
        );
        return;
      }

      // РАССЫЛКА: Ввод ID для отзыва через команду (альтернатива кнопке)
      if (tempData?.action === 'revoke_pro_input') {
        // Обработка выше уже покрывает это через msg.text
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

    // Обработка фото для рассылки
    this.bot.on('photo', async (msg) => {
      const chatId = msg.chat.id;
      const tempData = await userService.getTempData(msg.from.id);
      
      if (tempData?.action === 'broadcast_photo') {
        // Берем фото максимального размера
        const photo = msg.photo[msg.photo.length - 1];
        const caption = tempData.text;
        
        // Показываем превью перед отправкой
        const confirmKeyboard = {
          inline_keyboard: [
            [{ text: '✅ Подтвердить рассылку', callback_data: `broadcast_confirm_with_photo_${photo.file_id}` }],
            [{ text: '❌ Отмена', callback_data: 'broadcast_cancel' }]
          ]
        };
        
        await this.bot.sendPhoto(chatId, photo.file_id, {
          caption: `📢 <b>Превью рассылки:</b>\n\n${caption}`,
          parse_mode: 'HTML',
          reply_markup: confirmKeyboard
        });
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
        
        const isAdmin = config.bot.adminIds.includes(String(msg.from.id));
        const keyboard = [
          [{ text: '🏪 Добавить магазин' }, { text: '📊 Мои заказы' }],
          [{ text: '💎 Подписка' }]
        ];
        
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

    // 7. Команда /sub (Подписка)
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

    // 8. Команда /buy (Покупка PRO)
    this.bot.onText(/\/buy|Купить PRO/, async (msg) => {
      const chatId = msg.chat.id;
      
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
    });

    // 9. Команда /admin (Админ панель) - ОБНОВЛЕННАЯ
    this.bot.onText(/\/admin|🔧 Админ панель/, async (msg) => {
      const chatId = msg.chat.id;
      
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
              [{ text: '⚡ Выдать PRO', callback_data: 'admin_grant_pro' }],
              [{ text: '🚫 Отозвать PRO', callback_data: 'admin_revoke_pro' }],
              [{ text: '📢 Рассылка всем', callback_data: 'admin_broadcast' }]
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
        
        const userLink = `tg://user?id=${targetId}`;
        const displayName = targetUser.username 
          ? `@${targetUser.username}` 
          : `ID: ${targetId}`;
        
        await this.bot.sendMessage(chatId, 
          `✅ PRO выдан!\n\n` +
          `Пользователь: <a href="${userLink}">${displayName}</a>\n` +
          `Telegram ID: <code>${targetId}</code>\n` +
          `Срок: ${days} дней`,
          { parse_mode: 'HTML' }
        );
        
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

    // КОМАНДА ОТЗЫВА PRO (/revoke)
    this.bot.onText(/\/revoke (\d+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      
      if (!config.bot.adminIds.includes(String(msg.from.id))) {
        return;
      }
      
      const targetId = match[1];
      
      try {
        const targetUser = await userService.getUserByTelegramId(targetId);
        if (!targetUser) {
          return this.bot.sendMessage(chatId, '❌ Пользователь не найден');
        }

        const hasPro = await subscriptionService.hasActivePro(targetUser.id);
        if (!hasPro) {
          return this.bot.sendMessage(chatId, '❌ У пользователя нет активной PRO подписки');
        }

        await subscriptionService.revokePro(targetUser.id);
        
        await this.bot.sendMessage(chatId, 
          `✅ PRO отозван у пользователя @${targetUser.username || targetId}`
        );
        
        await this.bot.sendMessage(targetId,
          `⚠️ <b>Ваш PRO доступ деактивирован</b>\n\n` +
          `Ваш тариф изменен на FREE.\n` +
          `Ограничения:\n` +
          `• Макс. 1 магазин\n` +
          `• 50 заказов в день\n\n` +
          `Для возобновления: /sub`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        logger.error('Revoke command error:', err.message);
        await this.bot.sendMessage(chatId, '❌ Ошибка отзыва');
      }
    });

    // 11. Обработка inline кнопок (callback_query) - ОБНОВЛЕННАЯ
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

      // Админ: отозвать PRO (запрос ID)
      if (data === 'admin_revoke_pro') {
        await this.bot.answerCallbackQuery(query.id);
        await userService.setTempData(query.from.id, { action: 'revoke_pro' });
        await this.bot.sendMessage(chatId, 
          '🚫 Введите Telegram ID пользователя для отзыва PRO:\n\n' +
          'Пример: 123456789\n\n' +
          '⚠️ Пользователь получит уведомление о деактивации',
          { parse_mode: 'HTML' }
        );
      }

      // Админ: рассылка (начало)
      if (data === 'admin_broadcast') {
        await this.bot.answerCallbackQuery(query.id);
        await userService.setTempData(query.from.id, { action: 'broadcast_text' });
        await this.bot.sendMessage(chatId, 
          '📢 <b>Создание рассылки</b>\n\n' +
          'Введите текст сообщения для всех пользователей:\n\n' +
          'Поддерживается HTML разметка (b, i, code и т.д.)\n\n' +
          '❌ Для отмены введите /cancel',
          { parse_mode: 'HTML' }
        );
      }

      // Рассылка: отмена
      if (data === 'broadcast_cancel' || data === 'broadcast_cancel_final') {
        await this.bot.answerCallbackQuery(query.id);
        await userService.clearTempData(query.from.id);
        await this.bot.sendMessage(chatId, '❌ Рассылка отменена');
      }

      // Рассылка: прикрепить фото
      if (data === 'broadcast_attach_photo') {
        await this.bot.answerCallbackQuery(query.id, { text: 'Отправьте фото' });
        // Состояние уже broadcast_photo, просто напоминаем
        await this.bot.sendMessage(chatId, 
          '📷 Отправьте изображение (фото, не файл)\n\n' +
          'Бот использует его как обложку для рассылки'
        );
      }

      // Рассылка: отправить только текст
      if (data === 'broadcast_send_text_only') {
        await this.bot.answerCallbackQuery(query.id);
        const tempData = await userService.getTempData(query.from.id);
        
        if (!tempData?.text) {
          return this.bot.sendMessage(chatId, '❌ Ошибка: текст не найден');
        }

        // Подтверждение
        const confirmKeyboard = {
          inline_keyboard: [
            [{ text: '✅ Подтвердить рассылку', callback_data: 'broadcast_confirm_text_only' }],
            [{ text: '❌ Отмена', callback_data: 'broadcast_cancel' }]
          ]
        };

        await this.bot.sendMessage(chatId,
          `📢 <b>Превью рассылки (только текст):</b>\n\n${tempData.text}\n\n` +
          `Отправить всем пользователям?`,
          { parse_mode: 'HTML', reply_markup: confirmKeyboard }
        );
      }

      // Рассылка: подтверждение с фото
      if (data.startsWith('broadcast_confirm_with_photo_')) {
        await this.bot.answerCallbackQuery(query.id, { text: 'Начинаю рассылку...' });
        const photoId = data.replace('broadcast_confirm_with_photo_', '');
        const tempData = await userService.getTempData(query.from.id);
        
        if (!tempData?.text) {
          return this.bot.sendMessage(chatId, '❌ Ошибка: данные не найдены');
        }

        await this.executeBroadcast(chatId, tempData.text, photoId);
        await userService.clearTempData(query.from.id);
      }

      // Рассылка: подтверждение текста
      if (data === 'broadcast_confirm_text_only') {
        await this.bot.answerCallbackQuery(query.id, { text: 'Начинаю рассылку...' });
        const tempData = await userService.getTempData(query.from.id);
        
        if (!tempData?.text) {
          return this.bot.sendMessage(chatId, '❌ Ошибка: текст не найден');
        }

        await this.executeBroadcast(chatId, tempData.text, null);
        await userService.clearTempData(query.from.id);
      }

      // Пробный PRO (1 день) - автовыдача
      if (data === 'trial_pro') {
        await this.bot.answerCallbackQuery(query.id);
        
        try {
          const user = await userService.getUserByTelegramId(query.from.id);
          
          const hasPro = await subscriptionService.hasActivePro(user.id);
          if (hasPro) {
            return this.bot.sendMessage(chatId, '❌ У вас уже активна PRO подписка!');
          }

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

      // Кнопка "Купить PRO" (показать тарифы)
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

      // Запрос на покупку PRO
      if (data.startsWith('buy_pro_') && data !== 'buy_pro') {
        const days = data.replace('buy_pro_', '');
        await this.bot.answerCallbackQuery(query.id);
        
        const user = await userService.getUserByTelegramId(query.from.id);
        const userName = user.firstName 
          ? `${user.firstName} ${user.lastName || ''}`.trim()
          : (user.username || `ID: ${user.telegramId}`);
        const userLink = `tg://user?id=${user.telegramId}`;
        
        const adminMsg = `💳 <b>Новый запрос на PRO!</b>\n\n` +
          `👤 <b>Пользователь:</b> <a href="${userLink}">${userName}</a>\n` +
          `🆔 <b>ID:</b> <code>${user.telegramId}</code>\n` +
          `⏱ <b>Тариф:</b> ${days} дней\n\n` +
          `🔗 <a href="${userLink}">Открыть профиль</a>\n\n` +
          `Для выдачи отправь:\n` +
          `<code>/grant ${user.telegramId} ${days}</code>`;
        
        const adminKeyboard = {
          inline_keyboard: [
            [{ 
              text: '✅ Выдать PRO', 
              callback_data: `quick_grant_${user.telegramId}_${days}` 
            }],
            [{
              text: '💬 Написать пользователю',
              url: userLink
            }]
          ]
        };
        
        for (const adminId of config.bot.adminIds) {
          try {
            await this.bot.sendMessage(adminId, adminMsg, { 
              parse_mode: 'HTML',
              reply_markup: adminKeyboard
            });
          } catch (err) {
            logger.error('Failed to notify admin:', err.message);
          }
        }
        
        await this.bot.sendMessage(chatId,
          '✅ <b>Заявка отправлена!</b>\n\n' +
          'Администратор получил уведомление.\n' +
          'Если у вас есть вопросы, напишите нам.\n\n' +
          '⏳ Обычно активация занимает 10-30 минут.',
          { parse_mode: 'HTML' }
        );
      }

      // Быстрая выдача через кнопку
      if (data.startsWith('quick_grant_')) {
        const parts = data.split('_');
        const targetId = parts[2];
        const days = parts[3];
        
        if (!config.bot.adminIds.includes(String(query.from.id))) {
          return this.bot.answerCallbackQuery(query.id, { text: '⛔ Нет доступа' });
        }
        
        await this.bot.answerCallbackQuery(query.id, { text: 'Выдаю PRO...' });
        
        try {
          const targetUser = await userService.getUserByTelegramId(targetId);
          if (!targetUser) {
            return this.bot.sendMessage(chatId, '❌ Пользователь не найден');
          }
          
          await subscriptionService.grantPro(targetUser.id, parseInt(days));
          
          await this.bot.editMessageText(
            `✅ <b>PRO успешно выдан!</b>\n\n` +
            `Пользователь: ${targetUser.username || targetId}\n` +
            `Срок: ${days} дней`,
            {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML'
            }
          );
          
          await this.bot.sendMessage(targetId,
            `🎉 <b>Ваш PRO доступ активирован!</b>\n\n` +
            `⏳ Срок: ${days} дней\n` +
            `✅ Все функции разблокированы\n\n` +
            `Перейдите в профиль: /sub`,
            { parse_mode: 'HTML' }
          );
          
        } catch (err) {
          logger.error('Quick grant error:', err.message);
          await this.bot.sendMessage(chatId, '❌ Ошибка выдачи: ' + err.message);
        }
      }
    });
  }

  // Вспомогательный метод для выполнения рассылки
  async executeBroadcast(adminChatId, text, photoId) {
    try {
      const users = await userService.getAllUsersForBroadcast();
      const total = users.length;
      let success = 0;
      let failed = 0;
      
      // Отправляем статус админу
      const statusMsg = await this.bot.sendMessage(adminChatId, 
        `📤 <b>Рассылка начата...</b>\n\n` +
        `Всего пользователей: ${total}\n` +
        `Отправлено: 0\n` +
        `Ошибок: 0`,
        { parse_mode: 'HTML' }
      );

      // Рассылка с задержкой (30 сообщений в секунду ~ 1 каждые 34мс, но лучше 100мс для надежности)
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        try {
          if (photoId) {
            await this.bot.sendPhoto(user.telegramId, photoId, {
              caption: text,
              parse_mode: 'HTML'
            });
          } else {
            await this.bot.sendMessage(user.telegramId, text, { parse_mode: 'HTML' });
          }
          success++;
        } catch (err) {
          failed++;
          logger.error(`Broadcast failed for ${user.telegramId}:`, err.message);
        }

        // Обновляем статус каждые 10 пользователей
        if ((i + 1) % 10 === 0 || i === users.length - 1) {
          try {
            await this.bot.editMessageText(
              `📤 <b>Рассылка выполняется...</b>\n\n` +
              `Всего: ${total}\n` +
              `✅ Отправлено: ${success}\n` +
              `❌ Ошибок: ${failed}\n` +
              `⏳ Прогресс: ${Math.round(((i + 1) / total) * 100)}%`,
              {
                chat_id: adminChatId,
                message_id: statusMsg.message_id,
                parse_mode: 'HTML'
              }
            );
          } catch (e) {
            // Игнорируем ошибки редактирования
          }
        }

        // Задержка 50мс между сообщениями (~20 в секунду, безопасно для API)
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Итоговый отчет
      await this.bot.sendMessage(adminChatId,
        `✅ <b>Рассылка завершена!</b>\n\n` +
        `📊 Статистика:\n` +
        `• Всего пользователей: ${total}\n` +
        `• Успешно: ${success}\n` +
        `• Ошибок: ${failed}\n` +
        `• Процент доставки: ${Math.round((success / total) * 100)}%`,
        { parse_mode: 'HTML' }
      );

    } catch (err) {
      logger.error('Broadcast error:', err);
      await this.bot.sendMessage(adminChatId, '❌ Ошибка при выполнении рассылки: ' + err.message);
    }
  }
}
