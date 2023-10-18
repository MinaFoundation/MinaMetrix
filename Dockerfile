FROM node:16.20.1-alpine

COPY . /app
WORKDIR /app

RUN npm install --frozen-lockfile

EXPOSE 3000

CMD [ "node", "app.js" ]
