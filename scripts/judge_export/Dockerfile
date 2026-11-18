FROM python:3.12-slim
RUN pip install --no-cache-dir networkx==3.7 numpy==2.2.6 && useradd -m exporter
USER exporter
COPY export_binary.py /export_binary.py
