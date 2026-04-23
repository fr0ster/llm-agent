FROM node:20-alpine

# Server + peers required by smart-server.yaml (ollama LLM + ollama embeddings)
RUN npm install -g @mcp-abap-adt/llm-agent-server@latest \
                   @mcp-abap-adt/ollama-embedder@latest

WORKDIR /app

COPY smart-server.yaml /app/smart-server.yaml

EXPOSE 4004

CMD ["llm-agent", "--config", "/app/smart-server.yaml", "--log-stdout"]
