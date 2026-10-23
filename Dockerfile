# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY web ./web
COPY scripts ./scripts
COPY src ./src
COPY data ./data
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY data ./data
EXPOSE 3000
# GAME_ANTHROPIC_KEY is supplied at runtime; never bake it into the image.
CMD ["node", "dist/src/server.js"]
