# The verifier runs in its own container, built from this folder.
# Harbor copies /app/bot from the builder's container in before test.sh runs.
# Keep the Python and library versions the same as environment/Dockerfile.
# daytona and modal are optional at import time; required when TICKET_SANDBOX=daytona or modal.
FROM python:3.12-slim

RUN pip install --no-cache-dir litellm==1.103.2 requests==2.34.2 numpy==2.2.6 rank-bm25==0.2.2 networkx==3.7 ripgrep==15.1.0 llama-index-core==0.14.25 llama-index-embeddings-litellm==0.6.0 llama-index-retrievers-bm25==0.8.0 llama-index-llms-litellm==0.8.0 daytona==0.202.0 modal==1.6.3 \
    && useradd --create-home --shell /bin/bash bot

COPY . /tests/

ENV LITELLM_LOCAL_MODEL_COST_MAP=True

WORKDIR /tests
