import { PrismaClient } from '@prisma/client';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('MarketplaceService');
const prisma = new PrismaClient();

export class MarketplaceService {
  async create(data) {
    try {
      const marketplace = await prisma.marketplace.create({
        data: {
          userId: data.userId,
          name: data.name,
          apiKey: data.apiKey,
          apiSecret: data.apiSecret,
          isActive: true
        }
      });
      logger.info(`Marketplace created: ${marketplace.name}`);
      return marketplace;
    } catch (error) {
      logger.error('Create marketplace error: ' + error.message);
      throw error;
    }
  }

  async getByUser(userId) {
    return prisma.marketplace.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' }
    });
  }
}

export const marketplaceService = new MarketplaceService();
