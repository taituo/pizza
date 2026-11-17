from pizza_agent.harness.scripted import ScriptedHarness, parse_items
from pizza_agent.models import ChatMessage, TurnInput
from pizza_agent.tools import CommerceTools

from .conftest import MENU


def turn(message: str, history: list[ChatMessage] | None = None) -> TurnInput:
    return TurnInput(conversation_id="c1", history=history or [], message=message)


def test_parses_quantity_size_and_left_out_ingredients():
    items = parse_items("two large pepperoni without onion and a cola, please", MENU)
    assert items == [
        {"product_id": "pepperoni", "size": "large", "quantity": 2, "without": ["onion"]},
        {"product_id": "cola", "size": "normal", "quantity": 1, "without": []},
    ]


def test_qualifiers_stay_with_their_own_product():
    items = parse_items("1 margherita no basil, 3 large pepperonis and a mineral water", MENU)
    assert items == [
        {"product_id": "margherita", "size": "normal", "quantity": 1, "without": ["basil"]},
        {"product_id": "pepperoni", "size": "large", "quantity": 3, "without": []},
        {"product_id": "water", "size": "normal", "quantity": 1, "without": []},
    ]


def test_drinks_have_no_large_size():
    assert parse_items("a large cola", MENU)[0]["size"] == "normal"


async def test_an_order_becomes_a_proposal_priced_by_the_api(api):
    tools = CommerceTools(api.client(), "c1")
    out = await ScriptedHarness().run(turn("Two large pepperoni without onion, delivery please"), tools)
    assert tools.proposal_id == api.proposals[0]["id"]
    assert api.proposals[0]["request"]["fulfillment"] == "delivery"
    assert "€37.70" in out.reply  # 2 × 16.90 + 3.90 delivery, as computed by the API
    assert "confirm" in out.reply


async def test_fulfillment_follow_up_reuses_the_earlier_items(api):
    tools = CommerceTools(api.client(), "c1")
    history = [ChatMessage("user", "a margherita"), ChatMessage("agent", "Here is your order ...")]
    await ScriptedHarness().run(turn("delivery please", history), tools)
    assert api.proposals[0]["request"]["items"][0]["productId"] == "margherita"
    assert api.proposals[0]["request"]["fulfillment"] == "delivery"


async def test_menu_and_status_questions_do_not_create_proposals(api):
    tools = CommerceTools(api.client(), "c1")
    menu = await ScriptedHarness().run(turn("what do you have?"), tools)
    assert "Margherita (€10.90)" in menu.reply
    status = await ScriptedHarness().run(turn("where is my order?"), tools)
    assert "No orders" in status.reply
    assert api.proposals == []


def test_several_left_out_ingredients_in_one_clause():
    items = parse_items("a pepperoni without onion and mozzarella and two colas", MENU)
    assert items[0]["without"] == ["mozzarella", "onion"] or items[0]["without"] == ["onion", "mozzarella"]
    assert items[1] == {"product_id": "cola", "size": "normal", "quantity": 2, "without": []}
