FROM node:20-alpine

RUN npm install -g @mcp-abap-adt/llm-agent@latest

WORKDIR /app

COPY smart-server.yaml /app/smart-server.yaml

EXPOSE 4004

CMD ["llm-agent", "--config", "/app/smart-server.yaml", "--log-stdout"]
