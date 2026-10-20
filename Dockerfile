FROM oven/bun:1
WORKDIR /app
COPY Package.json ./package.json
RUN bun install
COPY Server.ts ./server.ts
ENV PORT=10000
EXPOSE 10000
CMD ["bun", "run", "server.ts"]
