FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json requirements.txt ./
RUN npm install --only=production && (pip3 install --break-system-packages -r requirements.txt || pip3 install -r requirements.txt)
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
