import { PrismaClient } from '@prisma/client';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('UserService');
const prisma = new PrismaClient();

export class UserService {
  // Временное хранилище для состояний пользователей (в памяти)
  tempStorage = new Map();

  async registerUser(telegramId, username) {
    try {
      let user = await prisma.user.findUnique({
        where: { telegramId: String(telegramId) },
        include: { subscriptions: { where: { isActive: true } } }
      });

      if (user) {
        if (user.username !== username) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { username },
            include: { subscriptions: { where: { isActive: true } } }
          });
        }
        return { user, isNew: false };
      }

      user = await prisma.user.create({
        data: {
          telegramId: String(telegramId),
          username,
          subscriptions: {
            create: {
              type: 'FREE',
              isActive: true,
            }
          }
        },
        include: { subscriptions: true }
      });

      return { user, isNew: true };
    } catch (error) {
      logger.error('Ошибка регистрации: ' + error.message);
      throw error;
    }
  }

  async getUserByTelegramId(telegramId) {
    return prisma.user.findUnique({
      where: { telegramId: String(telegramId) },
      include: {
        subscriptions: { where: { isActive: true } },
        marketplaces: { where: { isActive: true } },
      },
    });
  }

  async isAdmin(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });
    return user?.role === 'ADMIN';
  }

  // Методы для временного хранения данных (состояния диалогов)
  async setTempData(telegramId, data) {
    this.tempStorage.set(String(telegramId), data);
  }

  async getTempData(telegramId) {
    return this.tempStorage.get(String(telegramId));
  }

  async clearTempData(telegramId) {
    this.tempStorage.delete(String(telegramId));
  }

  // НОВЫЕ МЕТОДЫ ДЛЯ АДМИН-ПАНЕЛИ:
  
  async getAllUsers() {
    return prisma.user.findMany({
      include: {
        subscriptions: { where: { isActive: true } },
        _count: { select: { marketplaces: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
  }

  async getUserStats() {
    const total = await prisma.user.count();
    const pro = await prisma.subscription.count({
      where: { type: 'PRO', isActive: true }
    });
    return { total, pro, free: total - pro };
  }

  // ДЛЯ РАССЫЛКИ ВСЕМ ПОЛЬЗОВАТЕЛЯМ
  async getAllUsersForBroadcast() {
    return prisma.user.findMany({
      select: {
        telegramId: true,
        username: true
      }
    });
  }
}

export const user
