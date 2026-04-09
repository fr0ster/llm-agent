FROM node:20-alpine

RUN npm install -g @mcp-abap-adt/llm-agent@5.19.1

WORKDIR /app

# Symlink global package so plugins can import from '@mcp-abap-adt/llm-agent'
RUN mkdir -p node_modules && ln -s /usr/local/lib/node_modules/@mcp-abap-adt node_modules/@mcp-abap-adt

COPY plugins/ /app/plugins/
COPY skills/ /app/skills/
COPY smart-server.yaml /app/smart-server.yaml

EXPOSE 8010

CMD ["llm-agent"]
