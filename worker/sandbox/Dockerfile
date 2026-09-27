# Accaza AI task sandbox: the Linux box where AI-written code runs (see worker/lib/sandbox.js).
# It is started with no network, so everything a task may need is installed here.
# Rebuild after changing: docker build -t accaza-sandbox:1 worker/sandbox
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu fonts-liberation poppler-utils zip unzip file jq \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

RUN useradd --uid 1000 --create-home --shell /bin/bash sandbox
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
