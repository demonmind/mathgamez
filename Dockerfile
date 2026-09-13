FROM node:18-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM base
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp
USER nodeapp
EXPOSE 3000
CMD ["node", "server/index.js"]
