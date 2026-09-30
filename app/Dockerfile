# The birthday reminder app: the web pages and the clock that sends the day's
# messages. Built by `docker compose up` (the service sets
# `pull_policy: build`); never pushed anywhere.

# The same exact tag and digest as whatsapp/Dockerfile, which says why it is
# pinned. Bump the two together.
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY src ./src
COPY public ./public

# The database's directory, owned by `node` before the app_data volume first
# attaches — Docker seeds an empty named volume from it, ownership included.
RUN mkdir /data && chown node:node /data

USER node
EXPOSE 3210

# node:sqlite is built in, and still says it is experimental on every start.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.mjs"]
