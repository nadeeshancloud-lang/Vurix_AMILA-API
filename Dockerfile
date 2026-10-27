FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY python_engine/requirements.txt /app/python_engine/requirements.txt
RUN pip install --no-cache-dir -r /app/python_engine/requirements.txt
COPY backend/package*.json /app/backend/
WORKDIR /app/backend
RUN npm install --omit=dev
WORKDIR /app
COPY python_engine/ /app/python_engine/
COPY backend/ /app/backend/
WORKDIR /app/backend
ENV NODE_ENV=production PORT=8080 MAX_CONCURRENT_DOWNLOADS=1 MAX_MEDIA_BYTES=268435456 PREPARE_TIMEOUT_SECONDS=900
EXPOSE 8080
CMD ["npm", "start"]
