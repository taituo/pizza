"""One long-lived workflow per conversation.

The workflow owns the conversation's history and its lifecycle; the agent itself runs inside a
single activity per turn. Temporal therefore gives the conversation what an agent process cannot
give itself: it survives worker crashes and deploys, messages are answered strictly in order,
a turn that hangs is timed out and retried, and an idle conversation costs nothing.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from .models import ChatMessage, ConversationInput, TurnInput, TurnResult

IDLE_TIMEOUT = timedelta(minutes=30)
TURN_TIMEOUT = timedelta(seconds=75)
HISTORY_LIMIT = 30
TURNS_BEFORE_CONTINUE_AS_NEW = 50
FALLBACK_REPLY = "Sorry, I couldn't answer that just now. Please try again in a moment."


@workflow.defn(name="ConversationWorkflow")
class ConversationWorkflow:
    @workflow.init
    def __init__(self, inp: ConversationInput) -> None:
        self._id = inp.conversation_id
        self._harness = inp.harness
        self._history: list[ChatMessage] = list(inp.history)[-HISTORY_LIMIT:]
        self._lock = asyncio.Lock()
        self._in_flight = 0
        self._turns = 0
        self._activity = 0

    @workflow.run
    async def run(self, inp: ConversationInput) -> None:
        while True:
            seen = self._activity
            try:
                await workflow.wait_condition(lambda: self._activity != seen, timeout=IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                if self._in_flight == 0:
                    return  # idle: the next message starts a new run, seeded with history by the API
                continue
            if self._turns >= TURNS_BEFORE_CONTINUE_AS_NEW and self._in_flight == 0:
                await workflow.wait_condition(workflow.all_handlers_finished)
                workflow.continue_as_new(
                    ConversationInput(conversation_id=self._id, history=self._history, harness=self._harness)
                )

    @workflow.update
    async def send_message(self, text: str) -> TurnResult:
        self._in_flight += 1
        try:
            async with self._lock:  # one turn at a time, in arrival order
                try:
                    result: TurnResult = await workflow.execute_activity(
                        "run_turn",
                        TurnInput(
                            conversation_id=self._id,
                            history=list(self._history),
                            message=text,
                            harness=self._harness,
                        ),
                        result_type=TurnResult,
                        start_to_close_timeout=TURN_TIMEOUT,
                        heartbeat_timeout=timedelta(seconds=20),
                        retry_policy=RetryPolicy(maximum_attempts=2, initial_interval=timedelta(seconds=1)),
                    )
                except ActivityError:
                    result = TurnResult(reply=FALLBACK_REPLY, harness=self._harness or "", outcome="failed")
                self._history.append(ChatMessage(role="user", content=text))
                self._history.append(ChatMessage(role="agent", content=result.reply))
                del self._history[:-HISTORY_LIMIT]
                self._turns += 1
                return result
        finally:
            self._in_flight -= 1
            self._activity += 1

    @workflow.query
    def history(self) -> list[ChatMessage]:
        return self._history
