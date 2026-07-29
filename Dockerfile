# Prionman runs on a Raspberry Pi 5: build for linux/arm64 and listen on port 80.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

EXPOSE 80
USER node

# HTTP mode is multi-tenant: credentials arrive with each request, so no
# SmartBill secrets are baked into the image.
CMD ["node", "dist/index.js", "--http"]
