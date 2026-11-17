"""The adapter between Temporal and an agent harness: one activity, one turn."""

from __future__ import annotations

import asyncio
import contextlib
import time

import httpx
from temporalio import activity

from .config import Config
from .harness import Harness
from .models import TurnInput, TurnResult
from .tools import CommerceTools


class AgentActivities:
    def __init__(self, cfg: Config, harnesses: dict[str, Harness], client: httpx.AsyncClient | None = None) -> None:
        self._cfg = cfg
        self._harnesses = harnesses
        self._client = client or httpx.AsyncClient(
            base_url=cfg.api_url, headers={"x-agent-token": cfg.agent_token}, timeout=15
        )

    @activity.defn(name="run_turn")
    async def run_turn(self, inp: TurnInput) -> TurnResult:
        # An unknown or absent override falls back to the worker's default harness.
        harness = self._harnesses.get(inp.harness or "") or self._harnesses[self._cfg.harness]
        tools = CommerceTools(self._client, inp.conversation_id)
        started = time.monotonic()

        async def heartbeat() -> None:
            while True:
                activity.heartbeat()
                await asyncio.sleep(5)

        beat = asyncio.create_task(heartbeat())
        try:
            out = await harness.run(inp, tools)
        finally:
            beat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await beat

        return TurnResult(
            reply=out.reply,
            proposal_id=tools.proposal_id,
            harness=harness.name,
            model=out.model,
            outcome="proposed" if tools.proposal_id else "replied",
            tool_calls=tools.calls,
            blocked_tool_calls=out.blocked_tool_calls,
            input_tokens=out.input_tokens,
            output_tokens=out.output_tokens,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
