FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install
COPY server.ts ./
ENV PORT=10000
EXPOSE 10000
CMD ["bun", "run", "server.ts"]
