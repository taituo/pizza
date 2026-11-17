from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    api_url: str
    agent_token: str
    temporal_address: str
    temporal_namespace: str
    temporal_api_key: str
    task_queue: str
    harness: str
    model: str
    max_model_calls: int
    max_concurrent_turns: int


def load_config() -> Config:
    env = os.environ.get
    model = env("AGENT_MODEL", "")
    # Without a model there is nothing for Deep Agents to call: the scripted harness answers.
    harness = env("AGENT_HARNESS", "") or ("deepagents" if model else "scripted")
    if harness == "deepagents" and not model:
        raise RuntimeError("AGENT_HARNESS=deepagents requires AGENT_MODEL, e.g. anthropic:claude-sonnet-5-5")
    return Config(
        api_url=env("API_URL", "http://localhost:3000").rstrip("/"),
        agent_token=env("AGENT_TOKEN", "dev-agent-token"),
        temporal_address=env("TEMPORAL_ADDRESS", "localhost:7233"),
        temporal_namespace=env("TEMPORAL_NAMESPACE", "default"),
        temporal_api_key=env("TEMPORAL_API_KEY", ""),
        task_queue=env("TEMPORAL_AGENT_TASK_QUEUE", "agents"),
        harness=harness,
        model=model,
        max_model_calls=int(env("AGENT_MAX_MODEL_CALLS", "8")),
        max_concurrent_turns=int(env("AGENT_MAX_CONCURRENT_TURNS", "20")),
    )
