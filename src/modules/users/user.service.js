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
        marketplaces: true,
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
}

export const userService = new UserService();
