FROM node:20-alpine

# Server + peers required by smart-server.yaml
# LLM_PROVIDER and RAG_EMBEDDER are set via env at runtime; install all likely peers here.
# Add @mcp-abap-adt/openai-llm if LLM_PROVIDER=openai is used instead of sap-ai-sdk.
RUN npm install -g @mcp-abap-adt/llm-agent-server@latest \
                   @mcp-abap-adt/sap-aicore-llm@latest \
                   @mcp-abap-adt/sap-aicore-embedder@latest \
                   @mcp-abap-adt/qdrant-rag@latest

WORKDIR /app

# Symlink global packages so plugins can import from '@mcp-abap-adt/*'
RUN mkdir -p node_modules && ln -s /usr/local/lib/node_modules/@mcp-abap-adt node_modules/@mcp-abap-adt

COPY plugins/ /app/plugins/
COPY skills/ /app/skills/
COPY smart-server.yaml /app/smart-server.yaml

EXPOSE 8010

CMD ["llm-agent"]
