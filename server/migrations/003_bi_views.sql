-- BI views directly in the same Postgres (Metabase or similar reads these).
-- Everything is based on the order_events table, so a new metric needs no application change.

create view bi_orders as
select
  o.id,
  o.channel,
  o.fulfillment,
  o.status,
  o.cancel_reason,
  o.total_cents,
  o.created_at,
  (select min(e.created_at) from order_events e where e.order_id = o.id and e.type = 'payment.succeeded')        as paid_at,
  (select min(e.created_at) from order_events e where e.order_id = o.id and e.type = 'status.preparing')         as accepted_at,
  (select min(e.created_at) from order_events e where e.order_id = o.id and e.type = 'status.ready')             as ready_at,
  (select min(e.created_at) from order_events e where e.order_id = o.id and e.type = 'status.out_for_delivery')  as dispatched_at,
  (select min(e.created_at) from order_events e where e.order_id = o.id and e.type = 'status.completed')         as completed_at
from orders o;

-- Daily sales: revenue, order-to-payment conversion, average order value.
create view bi_sales_daily as
select
  date_trunc('day', created_at)                                     as day,
  count(*)                                                          as orders_created,
  count(*) filter (where paid_at is not null)                       as orders_paid,
  count(*) filter (where status = 'completed')                      as orders_completed,
  count(*) filter (where status = 'cancelled')                      as orders_cancelled,
  round(100.0 * count(*) filter (where paid_at is not null) / nullif(count(*), 0), 1) as payment_conversion_pct,
  coalesce(sum(total_cents) filter (where status = 'completed'), 0) / 100.0 as revenue_eur,
  round(avg(total_cents) filter (where status = 'completed') / 100.0, 2)    as avg_order_eur
from bi_orders
group by 1;

-- Where the chain slows down: stage durations in minutes.
create view bi_stage_durations as
select
  id,
  fulfillment,
  created_at,
  extract(epoch from (paid_at - created_at)) / 60        as min_to_payment,
  extract(epoch from (accepted_at - paid_at)) / 60       as min_kitchen_accept,
  extract(epoch from (ready_at - accepted_at)) / 60      as min_preparing,
  extract(epoch from (dispatched_at - ready_at)) / 60    as min_waiting_driver,
  extract(epoch from (completed_at - coalesce(dispatched_at, ready_at))) / 60 as min_handover,
  extract(epoch from (completed_at - created_at)) / 60   as min_total
from bi_orders
where status = 'completed';

create view bi_cancellations as
select date_trunc('day', created_at) as day, coalesce(cancel_reason, 'unknown') as reason, count(*) as orders
from orders
where status = 'cancelled'
group by 1, 2;

create view bi_product_sales as
select
  date_trunc('day', o.created_at) as day,
  item ->> 'productId'            as product_id,
  item ->> 'name'                 as product_name,
  item ->> 'size'                 as size,
  sum((item ->> 'quantity')::int)         as units,
  sum((item ->> 'lineTotalCents')::int) / 100.0 as revenue_eur
from orders o, jsonb_array_elements(o.priced_items) as item
where o.status = 'completed'
group by 1, 2, 3, 4;

create view bi_stock_levels as
select id, name, stock from ingredients;
