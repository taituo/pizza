-- Durable business state. Temporal keeps process execution state in its own databases.

create table products (
  id                text primary key,
  name              text not null,
  description       text not null default '',
  category          text not null check (category in ('pizza', 'drink')),
  price_cents       integer not null check (price_cents > 0),
  price_large_cents integer check (price_large_cents > 0),
  active            boolean not null default true,
  sort_order        integer not null default 0
);

create table ingredients (
  id    text primary key,
  name  text not null,
  stock integer not null check (stock >= 0)
);

create table product_ingredients (
  product_id    text not null references products (id) on delete cascade,
  ingredient_id text not null references ingredients (id),
  qty           integer not null check (qty > 0),
  removable     boolean not null default true,
  primary key (product_id, ingredient_id)
);

create table orders (
  id                uuid primary key,
  access_token      text not null,
  status            text not null default 'created' check (status in (
                      'created', 'awaiting_payment', 'paid', 'preparing',
                      'ready', 'out_for_delivery', 'completed', 'cancelled')),
  fulfillment       text not null check (fulfillment in ('delivery', 'pickup')),
  channel           text not null default 'web',
  customer_name     text not null,
  phone             text not null,
  address           text,
  lat               double precision,
  lng               double precision,
  items             jsonb not null,          -- the customer's request
  priced_items      jsonb,                   -- the version priced by the server
  delivery_fee_cents integer,
  total_cents       integer,
  driver_id         text,
  driver_lat        double precision,
  driver_lng        double precision,
  driver_updated_at timestamptz,
  cancel_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index orders_active_idx on orders (created_at)
  where status not in ('completed', 'cancelled');
create index orders_status_idx on orders (status);

-- One row per order: the reservation is idempotent and can be released exactly once.
create table stock_reservations (
  order_id   uuid primary key references orders (id),
  needs      jsonb not null,
  released   boolean not null default false,
  created_at timestamptz not null default now()
);

-- One row per order: the same order cannot be charged twice.
create table payments (
  order_id     uuid primary key references orders (id),
  provider     text not null,
  provider_ref text not null,
  status       text not null check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'refunded')),
  amount_cents integer not null,
  checkout_url text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index payments_provider_ref_idx on payments (provider_ref);

-- Business events: the shared source for the realtime UI and BI.
create table order_events (
  id         bigserial primary key,
  order_id   uuid not null references orders (id),
  type       text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index order_events_order_idx on order_events (order_id, id);
create index order_events_type_time_idx on order_events (type, created_at);

create table driver_positions (
  id          bigserial primary key,
  order_id    uuid not null references orders (id),
  driver_id   text not null,
  lat         double precision not null,
  lng         double precision not null,
  recorded_at timestamptz not null default now()
);
create index driver_positions_order_idx on driver_positions (order_id, id);
