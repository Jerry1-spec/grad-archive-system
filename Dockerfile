FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production
# 数据库目录默认指向持久卷挂载点（部署平台需将 /data 挂载为持久卷）
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
