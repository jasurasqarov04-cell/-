import { PrismaClient } from '@prisma/client';
import { createLogger } from '../../utils/logger.js';
import { decrypt } from '../../utils/encryption.js';
import { UzumAdapter } from '../marketplaces/adapters/uzum.adapter.js';

const logger = createLogger('OrderService');
const prisma = new PrismaClient();

export class OrderService {
  async syncOrders(userId, marketplaceId) {
    try {
      const marketplace = await prisma.marketplace.findFirst({
        where: { id: marketplaceId, userId, isActive: true }
      });

      if (!marketplace) {
        throw new Error('Marketplace not found');
      }

      // 🔴 ПРОВЕРКА: если API ключ "test" или "demo" — генерируем фейковые данные
      const apiKey = decrypt(marketplace.apiKey);
      
      if (apiKey.toLowerCase().includes('test') || apiKey.toLowerCase().includes('demo')) {
        logger.info('TEST MODE: Generating fake orders');
        return this.generateTestOrders(marketplace.id);
      }

      // Реальный API (если ключ настоящий)
      const apiSecret = marketplace.apiSecret ? decrypt(marketplace.apiSecret) : null;
      
      if (marketplace.name === 'UZUM') {
        const adapter = new UzumAdapter(apiKey, apiSecret);
        await adapter.initialize();
        
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 7);
        
        const orders = await adapter.getOrders(fromDate, new Date());
        return this.saveOrders(orders, marketplace.id);
      }
      
      throw new Error(`Adapter for ${marketplace.name} not implemented`);

    } catch (error) {
      logger.error('Sync orders error:', error.message);
      throw error;
    }
  }

  // 🧪 Генерация тестовых заказов
  async generateTestOrders(marketplaceId) {
    const testOrders = [
      {
        externalId: 'TEST-001',
        data: {
          totalAmount: 150000,
          items: ['iPhone 15', 'Чехол'],
          customer: '+998 90 123 45 67'
        },
        status: 'DELIVERED',
        createdAt: new Date(Date.now() - 86400000) // вчера
      },
      {
        externalId: 'TEST-002',
        data: {
          totalAmount: 45000,
          items: ['AirPods'],
          customer: '+998 91 234 56 78'
        },
        status: 'PENDING',
        createdAt: new Date(Date.now() - 172800000) // позавчера
      },
      {
        externalId: 'TEST-003',
        data: {
          totalAmount: 230000,
          items: ['Samsung TV', 'Кронштейн'],
          customer: '+998 93 345 67 89'
        },
        status: 'SHIPPED',
        createdAt: new Date()
      }
    ];

    let savedCount = 0;
    for (const order of testOrders) {
      try {
        await prisma.order.upsert({
          where: {
            marketplaceId_externalId: {
              marketplaceId: marketplaceId,
              externalId: order.externalId
            }
          },
          update: order,
          create: {
            marketplaceId: marketplaceId,
            ...order
          }
        });
        savedCount++;
      } catch (err) {
        logger.error('Save test order error:', err.message);
      }
    }

    logger.info(`TEST MODE: Saved ${savedCount} fake orders`);
    return { total: testOrders.length, saved: savedCount };
  }

  // Сохранение реальных заказов
  async saveOrders(orders, marketplaceId) {
    let savedCount = 0;
    for (const order of orders) {
      try {
        await prisma.order.upsert({
          where: {
            marketplaceId_externalId: {
              marketplaceId: marketplaceId,
              externalId: String(order.id)
            }
          },
          update: {
            data: order,
            status: order.status,
            updatedAt: new Date()
          },
          create: {
            marketplaceId: marketplaceId,
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
    return { total: orders.length, saved: savedCount };
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
      take: 50
    });
  }
}

export const orderService = new OrderService();
