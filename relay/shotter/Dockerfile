FROM ghcr.io/puppeteer/puppeteer:24
# Root so we can write to the shared volume; Chrome still sandboxless in-container.
USER root
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer
ENV NODE_PATH=/home/pptruser/node_modules
COPY shot.js /app/shot.js
CMD ["node", "/app/shot.js"]
