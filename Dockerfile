# Node 24 LTS line, pinned by digest (FR-SVR-012). Update the digest on purpose: `docker buildx imagetools inspect node:24-slim`.
ARG NODE_IMAGE=node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Lifecycle scripts stay off; the allow-list (scripts/check-lifecycle-scripts.mjs) is empty because the lock file has none for linux.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM ${NODE_IMAGE}
ARG VERSION=dev
ARG SOURCE=
LABEL org.opencontainers.image.title="DBLoom" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="${SOURCE}"
# Listens on all interfaces (container); the start rule then requires DBLOOM_PUBLIC_ORIGIN and DBLOOM_TRUST_PROXY.
# The Nitro output bundles its dependencies, so the runtime stage holds only `.output`. Node is PID 1 and srvx handles
# SIGTERM/SIGINT itself (SPEC/27 FR-SVR-014); `CI` and `TEST` must stay unset.
ENV NODE_ENV=production PORT=3000 DBLOOM_DATA_DIR=/data DBLOOM_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/.output ./.output
# Runtime hardening: the image only runs `node`, so npm, yarn and corepack (bundled in the base image, with their own
# findings) are removed; apt is upgraded because the pinned digest can lag the Debian security fix (CVE-2026-109518).
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade apt libapt-pkg6.0 \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
