# ============================================================
#  mes-ai-assistant 多阶段构建
#  Stage 1 (builder): 安装全量依赖并构建前端 dist/
#  Stage 2 (runtime): 仅安装运行所需依赖，由 Express 同时托管 dist/ 与 /api
# ============================================================

# ---------- Stage 1: 构建前端 ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 先只拷依赖清单，最大化利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 构建期环境变量（会被静态替换进前端产物）
# VITE_ADMIN_TOKEN：必须与运行时 ADMIN_TOKEN 完全一致，否则局域网设备上传/删除文档会 403
# VITE_BACKEND_URL：留空时前端自动使用页面同源地址（推荐，反向代理场景才需要显式指定）
ARG VITE_ADMIN_TOKEN=""
ARG VITE_BACKEND_URL=""
ENV VITE_ADMIN_TOKEN=$VITE_ADMIN_TOKEN
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

# 用编程式构建脚本（与本地 build.cjs 一致，避免 CLI 路径偶发挂死）
RUN node build.cjs

# ---------- Stage 2: 运行时 ----------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# 根依赖：server/pdfExtract.js 需要 pdfjs-dist（服务端 PDF 文本兜底提取）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 服务端依赖：express / cors / dotenv
COPY server/package.json server/package-lock.json ./server/
RUN cd /app/server && npm ci --omit=dev

# 拷贝源码（node_modules / data / .env 已被 .dockerignore 排除）
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=builder /app/dist ./dist

# 运行时配置（均可在 docker-compose / docker run 中覆盖）
ENV PORT=3001
# Docker 默认网络可能未启用 IPv6，绑定 '::' 会失败 → 容器内监听 0.0.0.0
ENV HOST=0.0.0.0
# 知识库数据统一落到 /data，便于挂载卷持久化
ENV MES_DATA_DIR=/data
# 容器内 127.0.0.1 默认是容器自身 → 需指向宿主机 Ollama
# compose 中已配 network_mode: host，此时 127.0.0.1 即宿主机；
# 若改用 bridge 网络，必须通过 OLLAMA_API_URL 覆盖为宿主机非回环 IP。
ENV OLLAMA_API_URL=http://127.0.0.1:11434/v1/chat/completions

RUN mkdir -p /data && chmod 755 /data

VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;require('http').get('http://127.0.0.1:'+p+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
