import { PrismaClient } from '@prisma/client';
import { createLogger } from '../../utils/logger.js';
import { decrypt } from '../../utils/encryption.js';
import { UzumAdapter } from '../marketplaces/adapters/uzum.adapter.js';

const logger = createLogger('OrderService');
const prisma = new PrismaClient();

export class OrderService {
  async syncOrders(userId, marketplaceId) {
    try {
      // Получаем магазин из БД
      const marketplace = await prisma.marketplace.findFirst({
        where: { id: marketplaceId, userId, isActive: true }
      });

      if (!marketplace) {
        throw new Error('Marketplace not found');
      }

      // Расшифровываем ключи
      const apiKey = decrypt(marketplace.apiKey);
      const apiSecret = marketplace.apiSecret ? decrypt(marketplace.apiSecret) : null;

      let orders = [];
      
      // Выбираем адаптер по типу маркетплейса
      if (marketplace.name === 'UZUM') {
        const adapter = new UzumAdapter(apiKey, apiSecret);
        await adapter.initialize();
        
        // Получаем заказы за последние 7 дней
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 7);
        
        orders = await adapter.getOrders(fromDate, new Date());
      } else {
        throw new Error(`Adapter for ${marketplace.name} not implemented yet`);
      }

      // Сохраняем заказы в БД
      let savedCount = 0;
      for (const order of orders) {
        try {
          await prisma.order.upsert({
            where: {
              marketplaceId_externalId: {
                marketplaceId: marketplace.id,
                externalId: String(order.id)
              }
            },
            update: {
              data: order,
              status: order.status,
              updatedAt: new Date()
            },
            create: {
              marketplaceId: marketplace.id,
              externalId: String(order.id),
              data: order,
              status: order.status
            }
          });
          savedCount++;
        } catch (err) {
          logger.error(`Failed to save order ${order.id}:`, err.message);
        }
      }

      logger.info(`Synced ${savedCount} orders for user ${userId}`);
      return { total: orders.length, saved: savedCount };
    } catch (error) {
      logger.error('Sync orders error:', error.message);
      throw error;
    }
  }

  async getOrdersByUser(userId, filters = {}) {
    return prisma.order.findMany({
      where: {
        marketplace: {
          userId: userId,
          isActive: true
        },
        ...(filters.status && { status: filters.status })
      },
      include: {
        marketplace: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 50 // Лимит для бесплатного тарифа
    });
  }
}

export const orderService = new OrderService();
