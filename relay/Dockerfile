FROM node:22-alpine
WORKDIR /relay
COPY server.js page.html ./
USER node
ENV PORT=8080 BASE_PATH=/cheating-daddy
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:${PORT}${BASE_PATH}/api/health || exit 1
CMD ["node", "server.js"]
