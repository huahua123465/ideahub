FROM node:22-alpine

WORKDIR /app

# 依赖单独装，吃 Docker 的层缓存
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY web ./web
COPY scripts ./scripts

# 前端打包。
# 源码是 27 个 ES 模块，浏览器要一个个去取 —— 实测在有延迟的网络上，
# 首屏时间几乎全花在这些请求的往返上（加了 ETag 之后传输量降了 90%，
# 时间却几乎没变，说明卡的是往返次数不是带宽）。
# 打成一个文件之后请求数从 31 降到个位数。
#
# esbuild 只在构建时用，不进最终镜像的运行时依赖 —— 装完就删。
RUN npm install --no-save esbuild@0.28.2 \
 && node scripts/build-web.mjs \
 && rm -rf node_modules/esbuild node_modules/@esbuild \
 && npm cache clean --force

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.mjs"]
