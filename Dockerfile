FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl curl

COPY package*.json ./
RUN npm ci --only=production

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

EXPOSE 3000

CMD ["node", "src/app.js"]