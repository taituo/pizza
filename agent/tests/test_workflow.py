"""The conversation workflow on a real Temporal dev server, with the scripted harness and a fake API.

TEMPORAL_CLI_PATH: use an already installed temporal binary. SKIP_TEMPORAL_TESTS=1: skip.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from temporalio.client import Client, WithStartWorkflowOperation
from temporalio.common import WorkflowIDConflictPolicy
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from pizza_agent.activities import AgentActivities
from pizza_agent.config import Config
from pizza_agent.harness import HarnessReply
from pizza_agent.harness.scripted import ScriptedHarness
from pizza_agent.models import ChatMessage, ConversationInput, TurnResult
from pizza_agent.workflows import FALLBACK_REPLY, ConversationWorkflow

pytestmark = pytest.mark.skipif(os.environ.get("SKIP_TEMPORAL_TESTS") == "1", reason="SKIP_TEMPORAL_TESTS=1")

QUEUE = "agents-test"
CFG = Config("http://api.test", "test-agent-token", "", "default", "", QUEUE, "scripted", "", 8, 20)


class BrokenHarness:
    name = "broken"
    attempts = 0

    async def run(self, turn, tools) -> HarnessReply:
        BrokenHarness.attempts += 1
        raise RuntimeError("model provider is down")


class SlowEcho:
    name = "echo"

    async def run(self, turn, tools) -> HarnessReply:
        await asyncio.sleep(0.3 if turn.message == "first" else 0)
        return HarnessReply(reply=f"{turn.message} after {len(turn.history)} earlier messages")


@pytest.fixture(scope="module")
async def env():
    path = os.environ.get("TEMPORAL_CLI_PATH")
    async with await WorkflowEnvironment.start_local(dev_server_existing_path=path) as e:
        yield e


async def send(client: Client, conversation_id: str, text: str, harness: str | None = None,
               history: list[ChatMessage] | None = None) -> TurnResult:  # fmt: skip
    """The same update-with-start the API performs."""
    start = WithStartWorkflowOperation(
        ConversationWorkflow.run,
        ConversationInput(conversation_id=conversation_id, history=history or [], harness=harness),
        id=f"conversation-{conversation_id}",
        task_queue=QUEUE,
        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
    )
    return await client.execute_update_with_start_workflow(
        ConversationWorkflow.send_message, text, start_workflow_operation=start
    )


async def test_conversation_keeps_history_orders_turns_and_survives_a_failing_harness(env, api):
    harnesses = {"scripted": ScriptedHarness(), "broken": BrokenHarness(), "echo": SlowEcho()}
    activities = AgentActivities(CFG, harnesses, client=api.client())
    async with Worker(env.client, task_queue=QUEUE, workflows=[ConversationWorkflow], activities=[activities.run_turn]):
        # 1. First message starts the workflow; the scripted harness proposes through the API.
        cid = str(uuid.uuid4())
        first = await send(env.client, cid, "one margherita")
        assert first.outcome == "proposed" and first.harness == "scripted"
        assert first.proposal_id == api.proposals[0]["id"]

        # 2. The follow-up reaches the same workflow, which supplies the history.
        second = await send(env.client, cid, "delivery please")
        assert second.outcome == "proposed"
        assert api.proposals[1]["request"]["fulfillment"] == "delivery"
        assert api.proposals[1]["request"]["items"][0]["productId"] == "margherita"
        history = await env.client.get_workflow_handle(f"conversation-{cid}").query(ConversationWorkflow.history)
        assert [m.role for m in history] == ["user", "agent", "user", "agent"]

        # 3. Concurrent messages are answered one at a time, in arrival order.
        cid = str(uuid.uuid4())
        slow = asyncio.create_task(send(env.client, cid, "first", harness="echo"))
        await asyncio.sleep(0.1)
        fast = await send(env.client, cid, "second", harness="echo")
        assert (await slow).reply == "first after 0 earlier messages"
        assert fast.reply == "second after 2 earlier messages"

        # 4. A harness that keeps failing is retried once, then the customer gets a fallback reply.
        cid = str(uuid.uuid4())
        failed = await send(env.client, cid, "hello", harness="broken")
        assert failed.outcome == "failed" and failed.reply == FALLBACK_REPLY
        assert BrokenHarness.attempts == 2

        # 5. A restarted conversation (e.g. after idling out) is seeded with the stored history.
        cid = str(uuid.uuid4())
        seeded = await send(env.client, cid, "again", harness="echo",
                            history=[ChatMessage("user", "hi"), ChatMessage("agent", "hello")])  # fmt: skip
        assert seeded.reply == "again after 2 earlier messages"
