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
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }]
      }
    });
    return !!sub;
  }

  async getSubscriptionInfo(userId) {
    const sub = await prisma.subscription.findFirst({
      where: { userId, isActive: true },
      orderBy: { startDate: 'desc' }  // <-- ИСПРАВЛЕНО ЗДЕСЬ
    });

    if (!sub) {
      return { type: 'FREE', status: 'inactive' };
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
}

export const subscriptionService = new SubscriptionService();
