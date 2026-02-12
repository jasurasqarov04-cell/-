import { PrismaClient } from '@prisma/client';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SubscriptionService');
const prisma = new PrismaClient();

export class SubscriptionService {
  async hasActivePro(userId) {
    const sub = await prisma.subscription.findFirst({
      where: {
        userId,
        type: 'PRO',
        isActive: true,  // УБЕДИТЕСЬ, что это поле есть в schema.prisma!
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }]
      }
    });
    return !!sub;
  }

  async getSubscriptionInfo(userId) {
    const sub = await prisma.subscription.findFirst({
      where: { 
        userId, 
        isActive: true  // Проверьте наличие этого поля в схеме!
      },
      orderBy: { startDate: 'desc' }
    });

    if (!sub || sub.type !== 'PRO') {
      return { type: 'FREE', status: 'inactive', daysLeft: 0 };
    }

    const daysLeft = sub.endDate 
      ? Math.ceil((sub.endDate - new Date()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      type: sub.type,
      status: sub.isActive ? 'active' : 'inactive',
      endDate: sub.endDate,
      daysLeft: daysLeft > 0 ? daysLeft : 0
    };
  }

  // ОТЗЫВ PRO — ИСПРАВЛЕННЫЙ (деактивирует, не удаляет)
  async revokePro(userId) {
    try {
      // Вариант 1: Если есть поле isActive в схеме — деактивируем
      await prisma.subscription.updateMany({
        where: {
          userId,
          type: 'PRO',
          isActive: true
        },
        data: {
          isActive: false,
          endDate: new Date() // Заканчиваем сегодня
        }
      });

      // Вариант 2: Если поля isActive НЕТ — просто ставим endDate в прошлое
      // Раскомментируйте это и закомментируйте блок выше, если isActive нет в схеме:
      /*
      await prisma.subscription.updateMany({
        where: {
          userId,
          type: 'PRO',
          endDate: { gt: new Date() }
        },
        data: {
          endDate: new Date(0) // 1970 год = точно истекла
        }
      });
      */

      logger.info(`PRO revoked for user ${userId}`);
      return { success: true };
    } catch (error) {
      logger.error('Revoke PRO error: ' + error.message);
      throw error;
    }
  }
  
  // Выдача PRO подписки
  async grantPro(userId, days = 30) {
    try {
      // Деактивируем текущие подписки
      await prisma.subscription.updateMany({
        where: { userId, isActive: true },  // Проверьте наличие isActive!
        data: { isActive: false }
      });

      // Создаем новую PRO подписку
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + days);

      const subscription = await prisma.subscription.create({
        data: {
          userId,
          type: 'PRO',
          endDate,
          isActive: true,  // Проверьте наличие isActive!
        }
      });

      logger.info(`PRO granted to user ${userId} until ${endDate}`);
      return subscription;
    } catch (error) {
      logger.error('Grant PRO error: ' + error.message);
      throw error;
    }
  }
}

export const subscriptionService = new SubscriptionService();
