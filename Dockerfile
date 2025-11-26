FROM node:18
RUN apt-get update && apt-get install -y chromium xvfb && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99

EXPOSE 10000
CMD ["bash", "-c", "Xvfb :99 -screen 0 1280x720x24 & node server.js"]
