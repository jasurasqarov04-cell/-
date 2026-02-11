FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl curl

COPY package*.json ./
RUN npm install

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

EXPOSE 3000

# Автоматически применяем миграции и запускаем сервер
CMD npx prisma migrate deploy && node src/app.js
