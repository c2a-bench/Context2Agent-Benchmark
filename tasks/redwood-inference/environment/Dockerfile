FROM python:3.12-slim

RUN pip install --no-cache-dir litellm==1.103.2 requests==2.34.2 numpy==2.2.6 rank-bm25==0.2.2 \
    && useradd --create-home --shell /bin/bash bot

COPY app/ /app/

ENV LITELLM_LOCAL_MODEL_COST_MAP=True

WORKDIR /app
