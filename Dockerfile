# Build stage
FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:24-alpine

WORKDIR /app

# Copy built assets
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package*.json ./
COPY healthcheck.js ./healthcheck.js

# Install production dependencies only
RUN npm install --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Health check using dedicated Node.js script
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node healthcheck.js

CMD ["npm", "run", "start:prod"]
