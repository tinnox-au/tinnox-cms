# syntax=docker/dockerfile:1
# API image for a deployed environment (docs/deployment-plan-2026-11-24.md, section 3.5).
# Build context: the repository root.
#   docker build -f apps/api/Dockerfile -t tinnox-cms-api .
#
# The image contains the API source, the five shared packages it imports and their
# production dependencies. It contains no secret, no migration, no script and no
# development tool: the migrator's credentials never reach it (AGENTS.md, section 1), and
# every setting arrives through the environment at start.
#
# A second image is built from the same file, for a release on a server:
#   docker build -f apps/api/Dockerfile --target release -t tinnox-cms-release .
# It adds the migrations, the migration command, the server's compose file and the release
# script to the same code, and runs the migrations when started. Only the release step
# runs it, with the migrator's connection string and nothing else (infra/deploy/release.sh).
# Node runs the TypeScript source directly, as the media worker's image does: the
# repository allows only erasable syntax (tsconfig.base.json), so there is no build step.
# Base: the same Node.js 24 (LTS) on Alpine 3.24 as the media worker, pinned by tag and digest.

FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
WORKDIR /app
# Only manifests: the lockfile decides every version. Install scripts are not run.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/media-worker/package.json apps/media-worker/
COPY apps/portal/package.json apps/portal/
COPY apps/player-web/package.json apps/player-web/
COPY packages/app-render/package.json packages/app-render/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/delivery/package.json packages/delivery/
COPY packages/domain/package.json packages/domain/
COPY packages/storage/package.json packages/storage/
COPY tests/package.json tests/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      --workspace @tinnox/api --workspace @tinnox/contracts --workspace @tinnox/db \
      --workspace @tinnox/delivery --workspace @tinnox/domain --workspace @tinnox/storage \
      --include-workspace-root=false \
 && rm -rf /root/.npm

FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
RUN addgroup -S -g 10002 api \
 && adduser -S -D -H -u 10002 -G api -s /sbin/nologin api \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data/media /data/jobs /etc/ssl/rds \
 && chown 10002:10002 /data/media /data/jobs
# The certificate authorities of Amazon RDS in Sydney, so a connection string can say
# sslmode=verify-full&sslrootcert=/etc/ssl/rds/ap-southeast-2-bundle.pem. RDS refuses
# connections without TLS, and Node does not trust these authorities by itself. The
# checksum fails the build when AWS changes the bundle: read the new one, then update it.
# The directory is made above: ADD would give a directory it creates the file's mode.
ADD --chmod=0444 --checksum=sha256:d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b \
    https://truststore.pki.rds.amazonaws.com/ap-southeast-2/ap-southeast-2-bundle.pem \
    /etc/ssl/rds/ap-southeast-2-bundle.pem
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/src ./apps/api/src
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/delivery ./packages/delivery
COPY packages/domain ./packages/domain
COPY packages/storage ./packages/storage
# The API imports the shared packages as TypeScript source. Node strips types only for
# files outside node_modules, so each package is linked exactly as npm workspaces link it.
RUN mkdir -p node_modules/@tinnox \
 && for p in contracts db delivery domain storage; do \
      rm -rf "node_modules/@tinnox/$p" && ln -s "../../packages/$p" "node_modules/@tinnox/$p"; \
    done
# API_HOST: the listener must be reachable from the reverse proxy's container. The two
# paths are the mount points of the media volume and of the job exchange shared with the
# media worker.
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    MEDIA_ROOT=/data/media \
    MEDIA_JOBS_DIR=/data/jobs \
    HOME=/tmp
USER 10002:10002

# The release image: the same code with what a release needs beside it.
FROM base AS release
COPY db/migrations ./db/migrations
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY scripts/lib/env.ts ./scripts/lib/env.ts
COPY infra/deploy/compose.yml infra/deploy/release.sh ./infra/deploy/
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "scripts/migrate.ts"]

# The API image. It is the last stage, so a build without --target makes it.
FROM base AS runtime
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "apps/api/src/main.ts"]
