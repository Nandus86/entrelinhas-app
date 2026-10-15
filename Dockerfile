FROM node:20-alpine

WORKDIR /app

# Instala dependências
COPY package*.json ./
RUN npm install --production

# Copia código da aplicação
COPY . .

# Expõe porta
EXPOSE 3000

# Executa servidor com auto-seed inicial
CMD ["node", "server.js"]
