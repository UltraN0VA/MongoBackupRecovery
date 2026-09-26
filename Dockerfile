FROM node:20-bookworm-slim

# Install MongoDB Database Tools (mongodump / mongorestore)
RUN apt-get update \
  && apt-get install -y --no-install-recommends gnupg curl \
  && curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor \
  && echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/8.0 main" | tee /etc/apt/sources.list.d/mongodb-org-8.0.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends mongodb-database-tools \
  && rm -rf /var/lib/apt/lists/* \
  && mongodump --version && mongorestore --version

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN mkdir -p backups uploads

EXPOSE 3000

CMD ["node", "server.js"]
