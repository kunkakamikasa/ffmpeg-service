
FROM node:20-bullseye
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
ENV PUBLIC_BASE_URL=""
ENV OUTPUT_DIR="/tmp/output"
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
