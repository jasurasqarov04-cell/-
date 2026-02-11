import { PrismaClient } from '@prisma/client';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SubscriptionService');
const prisma = new PrismaClient();

export class SubscriptionService {
  async hasActivePro(userId) {
    const subscription = await prisma.subscription.findFirst({
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
    return !!subscription;
  }

  async getSubscriptionInfo(userId) {
    const subscription = await prisma.subscription.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' }
    });

    if (!subscription) {
      return { type: 'FREE', status: 'inactive' };
    }

    const daysLeft = subscription.endDate 
      ? Math.ceil((subscription.endDate - new Date()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      type: subscription.type,
      status: subscription.isActive ? 'active' : 'inactive',
      endDate: subscription.endDate,
      daysLeft: daysLeft > 0 ? daysLeft : 0
    };
  }
}

export const subscriptionService = new SubscriptionService();