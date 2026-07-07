FROM node:22-slim
WORKDIR /app
COPY poll.js .
# No npm deps — global fetch + crypto only.
RUN node poll.js --selftest
CMD ["node", "poll.js"]
