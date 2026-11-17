-- Conversations with the ordering agent, the order proposals it makes, and per-turn run records for BI.
-- An agent can only create a proposal; an order exists only after the customer confirms one.

create table conversations (
  id            uuid primary key,
  access_token  text not null,
  channel       text not null default 'web',
  harness       text,                       -- optional per-conversation harness override
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table conversation_messages (
  id               bigserial primary key,
  conversation_id  uuid not null references conversations (id) on delete cascade,
  role             text not null check (role in ('user', 'agent')),
  content          text not null,
  created_at       timestamptz not null default now()
);
create index conversation_messages_idx on conversation_messages (conversation_id, id);

create table order_proposals (
  id                 uuid primary key,
  access_token       text not null,
  conversation_id    uuid references conversations (id) on delete set null,
  fulfillment        text not null check (fulfillment in ('delivery', 'pickup')),
  items              jsonb not null,          -- the request as the agent sent it
  priced_items       jsonb not null,          -- priced by the server at proposal time (shown to the customer)
  delivery_fee_cents integer not null,
  total_cents        integer not null,
  customer_name      text,
  phone              text,
  address            text,
  status             text not null default 'open' check (status in ('open', 'confirmed', 'superseded')),
  order_id           uuid references orders (id),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null
);
create index order_proposals_conversation_idx on order_proposals (conversation_id, created_at);

alter table orders add column conversation_id uuid references conversations (id) on delete set null;
create index orders_conversation_idx on orders (conversation_id) where conversation_id is not null;

-- One row per agent turn: which harness and model ran, what it cost and how it ended.
create table agent_runs (
  id                  bigserial primary key,
  conversation_id     uuid not null references conversations (id) on delete cascade,
  channel             text not null,
  harness             text not null,
  model               text,
  outcome             text not null check (outcome in ('replied', 'proposed', 'failed')),
  tool_calls          integer not null default 0,
  blocked_tool_calls  integer not null default 0,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  duration_ms         integer not null default 0,
  created_at          timestamptz not null default now()
);
create index agent_runs_time_idx on agent_runs (created_at);

-- Agent performance per day and harness: turns, failures, blocked tool calls, token use.
create view bi_agent_daily as
select date_trunc('day', created_at)::date                       as day,
       harness,
       coalesce(model, '-')                                      as model,
       count(*)                                                  as turns,
       count(*) filter (where outcome = 'proposed')              as proposals,
       count(*) filter (where outcome = 'failed')                as failures,
       sum(tool_calls)                                           as tool_calls,
       sum(blocked_tool_calls)                                   as blocked_tool_calls,
       sum(input_tokens)                                         as input_tokens,
       sum(output_tokens)                                        as output_tokens,
       round(avg(duration_ms))                                   as avg_duration_ms
  from agent_runs
 group by 1, 2, 3;

-- Conversation funnel per day and channel: conversation → proposal → confirmed order → paid order.
create view bi_conversation_funnel as
select date_trunc('day', c.created_at)::date                                     as day,
       c.channel,
       count(*)                                                                  as conversations,
       count(*) filter (where exists (select 1 from order_proposals p where p.conversation_id = c.id)) as with_proposal,
       count(*) filter (where exists (select 1 from orders o where o.conversation_id = c.id))          as with_order,
       count(*) filter (where exists (
         select 1 from orders o join payments pay on pay.order_id = o.id
          where o.conversation_id = c.id and pay.status = 'succeeded'))                                as with_paid_order
  from conversations c
 group by 1, 2;
