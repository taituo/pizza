"""A deterministic harness with no model behind it.

It understands plain orders ("two large pepperoni without onion and a cola, pickup"), menu and
status questions, by matching the customer's words against the live menu. It exists for three
reasons: the shop's chat works without any model API key, CI can run the whole agent path
end to end, and it proves the harness is replaceable: it uses the same tools, the same
workflow and the same API as the Deep Agents harness.
"""

from __future__ import annotations

import re
from typing import Any

from ..models import TurnInput
from ..tools import CommerceTools, describe_items, euros
from . import HarnessReply

NUMBERS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}  # fmt: skip
LARGE = re.compile(r"\b(large|big|family)\b")
# A left-out clause ends at punctuation or where the next item starts ("... and two colas").
WITHOUT = re.compile(
    r"\b(?:without|no|hold the|minus)\s+(.+?)(?=[.,;]|$|\s+and\s+(?:\d+|" + "|".join(NUMBERS) + r")\b)"
)
DELIVERY = re.compile(r"\b(deliver\w*|bring|to my (?:home|house|door|place|address)|home)\b")
PICKUP = re.compile(r"\b(pick\s?up|pick it up|collect\w*|take\s?away|takeout|fetch)\b")
STATUS = re.compile(r"\b(where|status|track\w*|how long|when will|my order|arriv\w*)\b")
MENU = re.compile(r"\b(menu|what do you (?:have|sell|offer)|options|recommend\w*|suggest\w*|choices)\b")


class ScriptedHarness:
    name = "scripted"

    async def run(self, turn: TurnInput, tools: CommerceTools) -> HarnessReply:
        menu = await tools.menu()
        text = turn.message.lower()

        items = parse_items(text, menu)
        if not items and (DELIVERY.search(text) or PICKUP.search(text) or re.search(r"\b(yes|ok|okay|confirm)\b", text)):
            # "Delivery, please" after an order: carry the items over from the earlier message.
            for earlier in reversed(turn.history):
                if earlier.role == "user":
                    items = parse_items(earlier.content.lower(), menu)
                    if items:
                        break

        if items:
            stated = fulfillment_in(text)
            fulfillment = stated or "pickup"
            result = await tools.propose_order(items, fulfillment)
            if tools.proposal_id is None:
                return HarnessReply(reply=f"I couldn't put that order together. {result}")
            reply = result.split(". The customer now sees")[0].replace("Proposal created: ", "Here is your order: ")
            reply += ". Check the card below, then confirm and pay."
            if stated is None:
                reply += " I assumed pickup; say “delivery” if you want it brought to you."
            return HarnessReply(reply=reply)

        if STATUS.search(text):
            return HarnessReply(reply=await tools.get_order_status())

        if MENU.search(text) or len(text.split()) <= 3:
            pizzas = [p for p in menu["products"] if p["category"] == "pizza"]
            listing = ", ".join(f"{p['name']} ({euros(p['priceCents'])})" for p in pizzas)
            return HarnessReply(
                reply=f"We have {listing}, plus drinks. Tell me what you'd like, "
                "for example “two large pepperoni without onion, delivery”."
            )

        return HarnessReply(
            reply="I can take your order, show the menu or check on an order. "
            "Tell me which pizzas you'd like and whether it's pickup or delivery."
        )


def fulfillment_in(text: str) -> str | None:
    if DELIVERY.search(text):
        return "delivery"
    if PICKUP.search(text):
        return "pickup"
    return None


def parse_items(text: str, menu: dict[str, Any]) -> list[dict[str, Any]]:
    """Finds product mentions and the quantity, size and left-out ingredients around each."""
    mentions: list[tuple[int, int, dict[str, Any]]] = []
    for product in menu["products"]:
        names = {product["name"].lower(), product["id"].lower()}
        names |= {n + "s" for n in names}
        pattern = r"\b(" + "|".join(sorted((re.escape(n) for n in names), key=len, reverse=True)) + r")\b"
        for m in re.finditer(pattern, text):
            mentions.append((m.start(), m.end(), product))
    mentions.sort(key=lambda m: (m[0], -(m[1] - m[0])))
    # A longer name wins over a shorter one inside it ("mineral water" over "water").
    kept: list[tuple[int, int, dict[str, Any]]] = []
    for m in mentions:
        if not kept or m[0] >= kept[-1][1]:
            kept.append(m)

    items: list[dict[str, Any]] = []
    for idx, (start, end, product) in enumerate(kept):
        before = text[kept[idx - 1][1] if idx else 0 : start]
        after = text[end : kept[idx + 1][0] if idx + 1 < len(kept) else len(text)]
        # "without onion" before a later product belongs to this one; quantity and size sit before the name.
        before = WITHOUT.sub(" ", before)

        quantity = 1
        for word in reversed(re.findall(r"[a-z]+|\d+", before)[-3:]):
            if word.isdigit():
                quantity = int(word)
                break
            if word in NUMBERS:
                quantity = NUMBERS[word]
                break

        is_last = idx + 1 == len(kept)
        large = bool(LARGE.search(before) or (is_last and LARGE.search(after)))
        size = "large" if large and product.get("priceLargeCents") is not None else "normal"

        without: list[str] = []
        for clause in WITHOUT.findall(after):
            for ingredient in product["removable"]:
                name = ingredient["name"].lower()
                if (name in clause or name.split()[-1] in clause or ingredient["id"] in clause) and ingredient[
                    "id"
                ] not in without:
                    without.append(ingredient["id"])

        items.append({"product_id": product["id"], "size": size, "quantity": max(1, min(quantity, 20)), "without": without})
    return items


__all__ = ["ScriptedHarness", "parse_items", "describe_items"]
