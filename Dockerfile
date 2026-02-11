FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl curl

COPY package*.json ./
RUN npm install

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

EXPOSE 3000

# Применяем миграции при старте контейнера и запускаем бота
CMD npx prisma migrate deploy && node src/app.js
