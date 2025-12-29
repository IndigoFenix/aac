# =============================================================================
# Multi-stage Dockerfile for CliniAACian
# =============================================================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# =============================================================================
# Stage 2: Production
# =============================================================================
FROM node:20-alpine AS production

# Security: Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built assets from builder
COPY --from=builder /app/dist ./dist

# Copy any other necessary files
# Adjust these based on your actual project structure
COPY --from=builder /app/drizzle ./drizzle

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Change to non-root user
USER nodejs

# Expose port
EXPOSE 5000

# Start the application
CMD ["node", "dist/index.js"]
