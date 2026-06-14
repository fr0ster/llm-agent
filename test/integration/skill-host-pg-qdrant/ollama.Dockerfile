# Base pinned by digest (resolved from ollama/ollama:latest at authoring time).
FROM ollama/ollama@sha256:05b6fe5143ed006d6d4abd39bdd575f962a5822bdf81e6fbb5e6894eb984ab9c
# Bake the embedding model INTO the image (deterministic; no re-pull at container
# start -> no network flakiness, no cold start). Pulled by TAG; the exact bytes are
# verified at runtime by run.mjs via /api/tags (the documented manifest-digest
# field) -- there is no verified pull-by-digest syntax across Ollama versions.
RUN ollama serve & \
    until ollama list >/dev/null 2>&1; do sleep 1; done; \
    ollama pull nomic-embed-text; \
    pkill ollama || true
