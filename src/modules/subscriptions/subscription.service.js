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
        isActive: true,
        OR: [
          { endDate: null }, 
          { endDate: { gt: new Date() } }
        ]
      }
    });
    return !!sub;
  }

  async getSubscriptionInfo(userId) {
    const sub = await prisma.subscription.findFirst({
      where: { 
        userId, 
        isActive: true 
      },
      orderBy: { startDate: 'desc' }
    });

    if (!sub || sub.type !== 'PRO') {
      return { type: 'FREE', status: 'inactive', daysLeft: 0, endDate: null };
    }

    const daysLeft = sub.endDate 
      ? Math.ceil((sub.endDate - new Date()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      type: sub.type,
      status: 'active',
      endDate: sub.endDate,
      daysLeft: daysLeft > 0 ? daysLeft : 0
    };
  }

  // ОТЗЫВ PRO (деактивация вместо удаления - сохраняет историю)
  async revokePro(userId) {
    try {
      await prisma.subscription.updateMany({
        where: {
          userId,
          type: 'PRO',
          isActive: true
        },
        data: {
          isActive: false,
          endDate: new Date() // Заканчиваем прямо сейчас
        }
      });

      logger.info(`PRO revoked for user ${userId}`);
      return { success: true };
    } catch (error) {
      logger.error('Revoke PRO error: ' + error.message);
      throw error;
    }
  }
  
  // ВЫДАЧА PRO
  async grantPro(userId, days = 30) {
    try {
      // Деактивируем текущие подписки
      await prisma.subscription.updateMany({
        where: { 
          userId, 
          isActive: true 
        },
        data: { 
          isActive: false 
        }
      });

      // Создаем новую PRO подписку
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + parseInt(days));

      const subscription = await prisma.subscription.create({
        data: {
          userId,
          type: 'PRO',
          endDate,
          isActive: true,
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
