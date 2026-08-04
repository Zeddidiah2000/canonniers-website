FROM node:22-slim
WORKDIR /app
COPY push.js .
# No npm deps — global fetch + fs only.
RUN node push.js --selftest
CMD ["node", "push.js"]
