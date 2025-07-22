FROM node:18-slim

# Install Chromium and required dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "index.js"]