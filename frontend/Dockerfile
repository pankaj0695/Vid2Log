# Standard 3-stage Next.js "standalone output" build — see next.config.ts's
# `output: "standalone"`. Produces a runtime image that only ships the
# server + the node_modules it actually traced as used, instead of the
# whole node_modules tree.
#
# IMPORTANT: every NEXT_PUBLIC_* value below is inlined into the compiled
# client JavaScript at BUILD time, not read at container startup — setting
# them as runtime env vars on the deployed container (e.g. `gcloud run
# deploy --set-env-vars`) has no effect. They must be passed as
# `--build-arg` at `docker build` time. See DEPLOYMENT.md (repo root),
# step 8, for the full build command.

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID
ARG NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY
ARG NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=$NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID \
    NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID \
    NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY=$NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY \
    NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID=$NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID

RUN npm run build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run injects its own $PORT (defaults to 8080); the standalone
# server.js reads process.env.PORT natively, so no extra wiring is needed —
# this is just the local/docker-compose default.
ENV PORT=8080

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
