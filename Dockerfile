FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
# Listens on all interfaces (container); the start rule then requires DBLOOM_PUBLIC_ORIGIN and DBLOOM_TRUST_PROXY.
ENV NODE_ENV=production PORT=3000 DBLOOM_DATA_DIR=/data DBLOOM_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/.output ./.output
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
