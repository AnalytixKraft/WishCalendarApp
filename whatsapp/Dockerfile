# The WhatsApp bridge. What it is and why it exists: README.md in this
# directory. Built by `docker compose up` (the service sets
# `pull_policy: build`); never pushed anywhere.

# PINNED TO AN EXACT PATCH TAG AND ITS DIGEST ON PURPOSE — do not "simplify" to
# node:24-alpine or node:lts-alpine. An exact tag plus digest cannot drift, and
# turns a re-pushed tag into a build failure instead of a silent change. The
# digest is the multi-arch OCI index, so the same line resolves to arm64 on a
# Mac and amd64 on a PC. To bump: take the new tag's index digest from the
# registry, and regenerate package-lock.json with the npm in that same image
# (README.md, "Upgrading"). Keep app/Dockerfile on the same pin.
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ENV NODE_ENV=production
WORKDIR /app

# Dependencies before code, so a code-only change reuses this layer.
COPY package.json package-lock.json ./
# npm ci          exactly the committed lockfile, or fail; never re-resolves.
# --omit=peer     Baileys declares `sharp` (native libvips) as a required peer,
#                 for image thumbnails. The bridge sends text only, and Baileys
#                 imports sharp lazily and carries on without it.
# --ignore-scripts  no dependency runs code at build time. Nothing here needs
#                 an install step (Baileys' only one is a Node-version check).
# The npm cache goes in the same layer, so it never ships.
RUN npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY src ./src

# The volume's mount point, owned by `node` before the volume first attaches.
# Docker seeds an EMPTY named volume from the image's directory, ownership
# included — so this is what lets the unprivileged process write its session.
# Without it whatsapp_auth comes up root-owned, and the first pairing dies
# with EACCES on /data/auth.
RUN mkdir /data && chown node:node /data

# uid 1000, the image's own unprivileged user. /app stays root-owned, so the
# process cannot rewrite its own code — and compose adds read_only on top.
USER node

# `node` directly, not `npm start`: npm is one more process between tini and
# the bridge for SIGTERM to cross, and it wants to write under $HOME, which
# the read-only root filesystem does not allow.
CMD ["node", "src/main.mjs"]
