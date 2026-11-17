"""Agent worker: polls the agents task queue for conversation workflows and agent turns."""

from __future__ import annotations

import asyncio
import logging
import signal

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import AgentActivities
from .config import Config, load_config
from .harness import Harness
from .harness.scripted import ScriptedHarness
from .workflows import ConversationWorkflow


def build_harnesses(cfg: Config) -> dict[str, Harness]:
    harnesses: dict[str, Harness] = {"scripted": ScriptedHarness()}
    if cfg.model:
        # Imported only when a model is configured: the scripted harness needs no model libraries loaded.
        from .harness.deep import DeepAgentsHarness

        harnesses["deepagents"] = DeepAgentsHarness(cfg.model, cfg.max_model_calls)
    return harnesses


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = load_config()
    client = await Client.connect(
        cfg.temporal_address,
        namespace=cfg.temporal_namespace,
        **({"api_key": cfg.temporal_api_key, "tls": True} if cfg.temporal_api_key else {}),
    )
    harnesses = build_harnesses(cfg)
    activities = AgentActivities(cfg, harnesses)
    worker = Worker(
        client,
        task_queue=cfg.task_queue,
        workflows=[ConversationWorkflow],
        activities=[activities.run_turn],
        max_concurrent_activities=cfg.max_concurrent_turns,
    )
    logging.info(
        'polling task queue "%s" at %s (default harness: %s, available: %s)',
        cfg.task_queue, cfg.temporal_address, cfg.harness, ", ".join(sorted(harnesses)),
    )  # fmt: skip

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with worker:
        await stop.wait()


if __name__ == "__main__":
    asyncio.run(main())
