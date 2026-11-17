# Agent worker image: docker build -t pizza-agent agent
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY pyproject.toml .
COPY pizza_agent pizza_agent
RUN pip install --no-deps . && useradd --uid 1000 --create-home agent
USER 1000
CMD ["python", "-m", "pizza_agent.worker"]
