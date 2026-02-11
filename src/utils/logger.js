import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { combine, timestamp, printf } = winston.format;

const logger = winston.createLogger({
  level: 'info',
  format: combine(
    timestamp(),
    printf(({ level, message, timestamp }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: join(__dirname, '../../logs/error.log'), level: 'error' }),
    new winston.transports.File({ filename: join(__dirname, '../../logs/combined.log') }),
  ],
});

export const createLogger = (context) => ({
  info: (msg) => logger.info(`[${context}] ${msg}`),
  error: (msg) => logger.error(`[${context}] ${msg}`),
});

export default logger;
