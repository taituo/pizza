"""Deep Agents as the ordering agent's harness.

Deep Agents does the planning and the tool loop; it is built fresh for every turn from the
conversation history, so the worker holds no state and any worker can answer the next message.
"""

from __future__ import annotations

from typing import Any, Literal

from deepagents import create_deep_agent
from langchain.agents.middleware import ModelCallLimitMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..guard import CommerceGuard
from ..models import TurnInput
from ..tools import CommerceTools
from . import HarnessReply

SYSTEM_PROMPT = """You take pizza orders for a restaurant, by chat.

How ordering works:
- Use get_menu before you talk about products or prices. Never quote a price from memory.
- When you know what the customer wants and whether it is pickup or delivery, call propose_order.
  The shop's system prices it and shows the customer a confirmation card. They confirm and pay
  there; you cannot place, change or pay for an order yourself, and you never ask for card details.
- If propose_order is rejected, fix the problem (ask the customer if you need to) and try again.
- After a proposal, tell the customer the total the tool returned and that they can confirm on the card.
- For delivery the customer marks the exact spot on the confirmation card's map; you only need to
  know that they want delivery. Pass a name, phone number or address along if they gave one.
- Use get_order_status when they ask about an order they already placed.

Keep replies short and friendly. Ask at most one question at a time. If the customer asks for
something the menu does not have, say so and suggest the closest thing. Do not discuss anything
unrelated to ordering from this restaurant."""


class Item(BaseModel):
    product_id: str = Field(description="Product id from the menu, e.g. 'pepperoni'")
    size: Literal["normal", "large"] = "normal"
    quantity: int = Field(default=1, ge=1, le=20)
    without: list[str] = Field(default_factory=list, description="Ingredient ids to leave out")


class ProposeOrderArgs(BaseModel):
    items: list[Item]
    fulfillment: Literal["delivery", "pickup"]
    customer_name: str | None = None
    phone: str | None = None
    address: str | None = Field(default=None, description="Street address, for delivery, if the customer gave one")


class NoArgs(BaseModel):
    pass


def commerce_tools(tools: CommerceTools) -> list[StructuredTool]:
    async def propose_order(
        items: list[Item],
        fulfillment: str,
        customer_name: str | None = None,
        phone: str | None = None,
        address: str | None = None,
    ) -> str:
        return await tools.propose_order(
            [i.model_dump() if isinstance(i, BaseModel) else i for i in items],
            fulfillment,
            customer_name,
            phone,
            address,
        )

    return [
        StructuredTool.from_function(
            coroutine=tools.get_menu,
            name="get_menu",
            description="The current menu: product ids, prices, sizes, ingredients that can be left out, delivery fee.",
            args_schema=NoArgs,
        ),
        StructuredTool.from_function(
            coroutine=propose_order,
            name="propose_order",
            description="Create an order proposal for the customer to confirm and pay. Returns the server-computed total.",
            args_schema=ProposeOrderArgs,
        ),
        StructuredTool.from_function(
            coroutine=tools.get_order_status,
            name="get_order_status",
            description="Status of the orders this customer has placed in this conversation.",
            args_schema=NoArgs,
        ),
    ]


def _text(message: AIMessage) -> str:
    content: Any = message.content
    if isinstance(content, str):
        return content.strip()
    return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()


class DeepAgentsHarness:
    name = "deepagents"

    def __init__(self, model: str | BaseChatModel, max_model_calls: int = 8) -> None:
        self._model_name = model if isinstance(model, str) else type(model).__name__
        self._model = init_chat_model(model) if isinstance(model, str) else model
        self._max_model_calls = max_model_calls

    async def run(self, turn: TurnInput, tools: CommerceTools) -> HarnessReply:
        lc_tools = commerce_tools(tools)
        guard = CommerceGuard({t.name for t in lc_tools})
        agent = create_deep_agent(
            model=self._model,
            tools=lc_tools,
            system_prompt=SYSTEM_PROMPT,
            middleware=[guard, ModelCallLimitMiddleware(run_limit=self._max_model_calls)],
        )
        messages = [
            {"role": "user" if m.role == "user" else "assistant", "content": m.content} for m in turn.history
        ] + [{"role": "user", "content": turn.message}]
        result = await agent.ainvoke({"messages": messages})

        produced = result["messages"][len(messages) :]
        ai = [m for m in produced if isinstance(m, AIMessage)]
        reply = next((t for t in (_text(m) for m in reversed(ai)) if t), "")
        usage = [m.usage_metadata or {} for m in ai]
        return HarnessReply(
            reply=reply or "Sorry, I lost my train of thought. Could you say that again?",
            model=self._model_name,
            blocked_tool_calls=len(guard.blocked),
            input_tokens=sum(u.get("input_tokens", 0) for u in usage),
            output_tokens=sum(u.get("output_tokens", 0) for u in usage),
        )
