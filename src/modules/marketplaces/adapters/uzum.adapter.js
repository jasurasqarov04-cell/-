import axios from 'axios';
import { decrypt } from '../../../utils/encryption.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('UzumAdapter');

export class UzumAdapter {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = 'https://api.uzum.uz/api';
    this.shopId = null;
  }

  async initialize() {
    try {
      // Получаем список магазинов
      const shops = await this.request('/seller/shops');
      if (shops && shops.length > 0) {
        this.shopId = shops[0].id;
        logger.info(`Uzum adapter initialized, shopId: ${this.shopId}`);
        return true;
      }
      throw new Error('No shops found in Uzum account');
    } catch (error) {
      logger.error('Uzum init error:', error.message);
      throw error;
    }
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    try {
      const response = await axios({
        url,
        method: options.method || 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        data: options.body,
        timeout: 30000,
      });

      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        throw new Error('Invalid Uzum API credentials');
      }
      if (error.response?.status === 429) {
        throw new Error('Uzum API rate limit exceeded');
      }
      throw error;
    }
  }

  async getOrders(fromDate, toDate) {
    try {
      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate.toISOString());
      if (toDate) params.append('to', toDate.toISOString());
      
      const orders = await this.request(`/seller/shops/${this.shopId}/orders?${params}`);
      
      logger.info(`Fetched ${orders?.length || 0} orders from Uzum`);
      return orders || [];
    } catch (error) {
      logger.error('Get Uzum orders error:', error.message);
      throw error;
    }
  }

  async getOrderDetails(orderId) {
    return this.request(`/seller/shops/${this.shopId}/orders/${orderId}`);
  }
}
