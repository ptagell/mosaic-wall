FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY immich.js models.js scenes.js photo_index.js picker.js server.js tile.html admin.html camera.html ./

EXPOSE 4000

CMD ["node", "server.js"]
