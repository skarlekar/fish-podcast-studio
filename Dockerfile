# Podcast Studio — zero npm dependencies, so the image is just Node plus the app files.
# Keys and episodes are NOT baked in: start-docker.sh mounts ./.env and ./output from the host.
FROM node:22-alpine

# ffmpeg makes the iPhone-friendly .m4a downloads (AAC with cover art). The app still runs without it; that button is just dimmed.
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json server.js ./
COPY public ./public
# Sample episodes, copied into an empty library on first start.
COPY samples ./samples

# Listen on all interfaces inside the container; start-docker.sh publishes the port on the host's 127.0.0.1 only.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    OUTPUT_DIR=/app/output \
    ENV_FILE=/app/.env

# The container may run as the host user (start-docker.sh passes --user), so the app files must be world-readable
# even when the checkout is owner-only; output/ must be writable.
RUN chmod -R a+rX /app && mkdir -p /app/output && chown node:node /app/output
USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
