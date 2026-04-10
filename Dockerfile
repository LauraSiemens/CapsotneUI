# Air monitor: static UI (8765) + optional serial→WebSocket bridge (8766).
# See README.md for SERIAL_PORT and USB device mapping notes.

FROM python:3.12-slim-bookworm

WORKDIR /app

COPY scripts/requirements-bridge.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY ui ./ui
COPY scripts ./scripts
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8765 8766

ENTRYPOINT ["/entrypoint.sh"]
