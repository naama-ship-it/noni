# Noni — תמונת Cloud Run
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js schema.sql ./
COPY public ./public
EXPOSE 8080
CMD ["node", "server.js"]
