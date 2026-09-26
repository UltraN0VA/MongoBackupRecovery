FROM node:20-bookworm-slim

# Install MongoDB Database Tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar \
  && curl -L https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-100.13.0.tgz \
     -o /tmp/mongodb-tools.tgz \
  && tar -xzf /tmp/mongodb-tools.tgz -C /tmp \
  && cp /tmp/mongodb-database-tools-*/bin/mongodump /usr/local/bin/ \
  && cp /tmp/mongodb-database-tools-*/bin/mongorestore /usr/local/bin/ \
  && rm -rf /tmp/mongodb* \
  && mongodump --version \
  && mongorestore --version \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p backups uploads

EXPOSE 3000

CMD ["node", "server.js"]