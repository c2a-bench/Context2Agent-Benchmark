FROM python:3.12-slim

RUN pip install --no-cache-dir litellm==1.103.2 requests==2.34.2 numpy==2.2.6 rank-bm25==0.2.2 networkx==3.7 ripgrep==15.1.0 llama-index-core==0.14.25 llama-index-embeddings-litellm==0.6.0 llama-index-retrievers-bm25==0.8.0 llama-index-llms-litellm==0.8.0 \
    && useradd --create-home --shell /bin/bash bot

COPY app/ /app/
# one file time for every doc, so no doc stands out by when it was written or edited
RUN find /app/docs /app/api_docs -exec touch -d "2026-05-20 00:00:00 UTC" {} +

ENV LITELLM_LOCAL_MODEL_COST_MAP=True

WORKDIR /app
