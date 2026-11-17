insert into ingredients (id, name, stock) values
  ('dough',      'Taikinapallo',   2000),
  ('tomato',     'Tomaattikastike', 2000),
  ('mozzarella', 'Mozzarella',     2000),
  ('basil',      'Basilika',       1000),
  ('pepperoni',  'Pepperoni',      1000),
  ('ham',        'Kinkku',         1000),
  ('pineapple',  'Ananas',         1000),
  ('mushroom',   'Herkkusieni',    1000),
  ('onion',      'Punasipuli',     1000),
  ('olive',      'Oliivi',         1000),
  ('jalapeno',   'Jalapeño',       1000),
  ('nduja',      '''Nduja',        500),
  ('gorgonzola', 'Gorgonzola',     500),
  ('rucola',     'Rucola',         500),
  ('cola',       'Cola 0,33 l',    1000),
  ('water',      'Kivennäisvesi 0,33 l', 1000);

insert into products (id, name, description, category, price_cents, price_large_cents, sort_order) values
  ('margherita', 'Margherita', 'Tomaatti, mozzarella, basilika', 'pizza', 1090, 1490, 10),
  ('pepperoni',  'Pepperoni',  'Tomaatti, mozzarella, pepperoni, punasipuli', 'pizza', 1290, 1690, 20),
  ('diavola',    'Diavola',    'Tulinen: ''nduja, pepperoni, jalapeño, punasipuli', 'pizza', 1390, 1790, 30),
  ('hawaii',     'Havaiji',    'Kinkku, ananas, mozzarella', 'pizza', 1290, 1690, 40),
  ('funghi',     'Funghi',     'Herkkusieni, mozzarella, rucola', 'pizza', 1250, 1650, 50),
  ('quattro',    'Gorgonzola & oliivi', 'Gorgonzola, mozzarella, oliivi, rucola', 'pizza', 1390, 1790, 60),
  ('cola',       'Cola',       '0,33 l tölkki', 'drink', 290, null, 100),
  ('water',      'Kivennäisvesi', '0,33 l pullo', 'drink', 250, null, 110);

insert into product_ingredients (product_id, ingredient_id, qty, removable) values
  ('margherita', 'dough', 1, false), ('margherita', 'tomato', 1, false), ('margherita', 'mozzarella', 2, true), ('margherita', 'basil', 1, true),
  ('pepperoni', 'dough', 1, false), ('pepperoni', 'tomato', 1, false), ('pepperoni', 'mozzarella', 2, true), ('pepperoni', 'pepperoni', 2, true), ('pepperoni', 'onion', 1, true),
  ('diavola', 'dough', 1, false), ('diavola', 'tomato', 1, false), ('diavola', 'mozzarella', 2, true), ('diavola', 'nduja', 1, true), ('diavola', 'pepperoni', 1, true), ('diavola', 'jalapeno', 1, true), ('diavola', 'onion', 1, true),
  ('hawaii', 'dough', 1, false), ('hawaii', 'tomato', 1, false), ('hawaii', 'mozzarella', 2, true), ('hawaii', 'ham', 2, true), ('hawaii', 'pineapple', 1, true),
  ('funghi', 'dough', 1, false), ('funghi', 'tomato', 1, false), ('funghi', 'mozzarella', 2, true), ('funghi', 'mushroom', 2, true), ('funghi', 'rucola', 1, true),
  ('quattro', 'dough', 1, false), ('quattro', 'tomato', 1, false), ('quattro', 'mozzarella', 1, true), ('quattro', 'gorgonzola', 2, true), ('quattro', 'olive', 1, true), ('quattro', 'rucola', 1, true),
  ('cola', 'cola', 1, false),
  ('water', 'water', 1, false);
