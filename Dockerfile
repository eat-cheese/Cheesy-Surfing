FROM node:18

RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 10000
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "server.js"]
