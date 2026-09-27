FROM python:3.11-slim
WORKDIR /speech
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY speech/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY speech/*.py ./
ENV SPEECH_MODEL_DIR=/models SPEECH_CACHE_DIR=/cache SPEECH_THREADS=2
EXPOSE 8001
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
