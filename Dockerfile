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

# Runs as root deliberately: the platform requires port 80, and binding a port
# below 1024 needs either root or CAP_NET_BIND_SERVICE, which the container is
# not guaranteed to keep. A non-root USER here fails with EACCES at startup.

# Lets the platform tell a started container from a ready one, so a redeploy
# does not cut over before the new one can serve. Uses node rather than curl or
# wget: node is the one binary this image is guaranteed to have.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:80/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# HTTP mode is multi-tenant: credentials arrive with each request, so no
# SmartBill secrets are baked into the image.
CMD ["node", "dist/index.js", "--http"]
