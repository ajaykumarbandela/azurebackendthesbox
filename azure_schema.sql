-- ============================================================
-- TheSBox — Azure SQL (T-SQL) schema, translated from Supabase/Postgres.
-- Idempotent: each table is guarded by IF NOT EXISTS.
-- NOTE: Postgres enums -> nvarchar + CHECK. uuid -> uniqueidentifier.
--       timestamptz -> datetimeoffset. text -> nvarchar(max), except
--       indexed/unique key columns which use bounded nvarchar.
--       Supabase auth.users has NO Azure equivalent: profiles.id is kept
--       as a plain uniqueidentifier PK (no FK to an auth table).
-- ============================================================

-- ── profiles ────────────────────────────────────────────────
IF OBJECT_ID('dbo.profiles', 'U') IS NULL
CREATE TABLE dbo.profiles (
  id              uniqueidentifier PRIMARY KEY,
  name            nvarchar(max) NOT NULL,
  phone           nvarchar(64),
  role            nvarchar(20) DEFAULT 'customer'
                    CONSTRAINT ck_profiles_role CHECK (role IN ('admin','employee','customer','superadmin')),
  employee_status nvarchar(20)
                    CONSTRAINT ck_profiles_empstatus CHECK (employee_status IN ('pending','approved','rejected')),
  fcm_token       nvarchar(max),
  whatsapp        nvarchar(64),
  email           nvarchar(320) NULL,        -- migrated from Supabase auth.users
  password_hash   nvarchar(255) NULL,        -- bcrypt; NULL until user sets a password
  active          bit NOT NULL DEFAULT 1,    -- replaces Supabase ban_duration
  created_at      datetimeoffset DEFAULT sysdatetimeoffset(),
  updated_at      datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='uq_profiles_email' AND object_id=OBJECT_ID('dbo.profiles'))
  CREATE UNIQUE INDEX uq_profiles_email ON dbo.profiles(email) WHERE email IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_profiles_role' AND object_id=OBJECT_ID('dbo.profiles'))
  CREATE INDEX idx_profiles_role ON dbo.profiles(role);
GO

-- ── categories ──────────────────────────────────────────────
IF OBJECT_ID('dbo.categories', 'U') IS NULL
CREATE TABLE dbo.categories (
  id          uniqueidentifier PRIMARY KEY DEFAULT newid(),
  name        nvarchar(max) NOT NULL,
  slug        nvarchar(255) NOT NULL UNIQUE,
  description nvarchar(max),
  image_url   nvarchar(max),
  parent_id   uniqueidentifier NULL REFERENCES dbo.categories(id),
  created_at  datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_categories_parent' AND object_id=OBJECT_ID('dbo.categories'))
  CREATE INDEX idx_categories_parent ON dbo.categories(parent_id);
GO

-- ── products ────────────────────────────────────────────────
IF OBJECT_ID('dbo.products', 'U') IS NULL
CREATE TABLE dbo.products (
  id            uniqueidentifier PRIMARY KEY DEFAULT newid(),
  title         nvarchar(max) NOT NULL,
  description   nvarchar(max),
  type          nvarchar(20) NOT NULL
                  CONSTRAINT ck_products_type CHECK (type IN ('saree','jewellery')),
  category_id   uniqueidentifier NULL REFERENCES dbo.categories(id),
  base_price    decimal(10,2) NOT NULL CONSTRAINT ck_products_base_price CHECK (base_price > 0),
  discount_pct  decimal(5,2) DEFAULT 0 CONSTRAINT ck_products_discount CHECK (discount_pct >= 0 AND discount_pct <= 100),
  coupon_code   nvarchar(255),
  coupon_disc   decimal(5,2),
  published     bit DEFAULT 0,
  created_by    uniqueidentifier NULL REFERENCES dbo.profiles(id),
  created_at    datetimeoffset DEFAULT sysdatetimeoffset(),
  updated_at    datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_products_published' AND object_id=OBJECT_ID('dbo.products'))
  CREATE INDEX idx_products_published ON dbo.products(published);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_products_type' AND object_id=OBJECT_ID('dbo.products'))
  CREATE INDEX idx_products_type ON dbo.products(type);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_products_category' AND object_id=OBJECT_ID('dbo.products'))
  CREATE INDEX idx_products_category ON dbo.products(category_id);
GO

-- ── product_images ──────────────────────────────────────────
IF OBJECT_ID('dbo.product_images', 'U') IS NULL
CREATE TABLE dbo.product_images (
  id            uniqueidentifier PRIMARY KEY DEFAULT newid(),
  product_id    uniqueidentifier NULL REFERENCES dbo.products(id) ON DELETE CASCADE,
  url           nvarchar(max) NOT NULL,
  alt_text      nvarchar(max),
  is_primary    bit DEFAULT 0,
  color         nvarchar(255),
  display_order int DEFAULT 0
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_product_images_product' AND object_id=OBJECT_ID('dbo.product_images'))
  CREATE INDEX idx_product_images_product ON dbo.product_images(product_id);
GO

-- ── variants ────────────────────────────────────────────────
IF OBJECT_ID('dbo.variants', 'U') IS NULL
CREATE TABLE dbo.variants (
  id          uniqueidentifier PRIMARY KEY DEFAULT newid(),
  product_id  uniqueidentifier NULL REFERENCES dbo.products(id) ON DELETE CASCADE,
  color       nvarchar(255),
  size        nvarchar(255),
  quantity    int DEFAULT 0 CONSTRAINT ck_variants_qty CHECK (quantity >= 0),
  sold_count  int DEFAULT 0 CONSTRAINT ck_variants_sold CHECK (sold_count >= 0),
  sku         nvarchar(255) UNIQUE,
  image_url   nvarchar(max),
  created_at  datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_variants_product' AND object_id=OBJECT_ID('dbo.variants'))
  CREATE INDEX idx_variants_product ON dbo.variants(product_id);
GO

-- ── addresses ───────────────────────────────────────────────
IF OBJECT_ID('dbo.addresses', 'U') IS NULL
CREATE TABLE dbo.addresses (
  id         uniqueidentifier PRIMARY KEY DEFAULT newid(),
  user_id    uniqueidentifier NULL REFERENCES dbo.profiles(id) ON DELETE CASCADE,
  line1      nvarchar(max) NOT NULL,
  line2      nvarchar(max),
  city       nvarchar(255) NOT NULL,
  state      nvarchar(255) NOT NULL,
  pincode    nvarchar(32) NOT NULL,
  country    nvarchar(128) DEFAULT 'India',
  is_default bit DEFAULT 0,
  created_at datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_addresses_user' AND object_id=OBJECT_ID('dbo.addresses'))
  CREATE INDEX idx_addresses_user ON dbo.addresses(user_id);
GO

-- ── orders ──────────────────────────────────────────────────
IF OBJECT_ID('dbo.orders', 'U') IS NULL
CREATE TABLE dbo.orders (
  id                      uniqueidentifier PRIMARY KEY DEFAULT newid(),
  user_id                 uniqueidentifier NULL REFERENCES dbo.profiles(id),
  address_id              uniqueidentifier NULL REFERENCES dbo.addresses(id),
  status                  nvarchar(20) DEFAULT 'placed'
                            CONSTRAINT ck_orders_status CHECK (status IN ('placed','confirmed','processing','shipped','delivered','cancelled','refunded')),
  total_amount            decimal(10,2) NOT NULL,
  discount_amount         decimal(10,2) DEFAULT 0,
  coupon_applied          nvarchar(255),
  razorpay_order_id       nvarchar(255),
  razorpay_payment_id     nvarchar(255),
  refund_status           nvarchar(255),
  refund_reason           nvarchar(max),
  shiprocket_order_id     nvarchar(255),
  shiprocket_shipment_id  nvarchar(255),
  shiprocket_awb          nvarchar(255),
  shiprocket_courier_id   int,
  shiprocket_courier_name nvarchar(255),
  tracking_url            nvarchar(max),
  shipment_status         nvarchar(255),
  expected_delivery_date  date,
  label_url               nvarchar(max),
  invoice_url             nvarchar(max),
  manifest_url            nvarchar(max),
  created_at              datetimeoffset DEFAULT sysdatetimeoffset(),
  updated_at              datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_orders_user' AND object_id=OBJECT_ID('dbo.orders'))
  CREATE INDEX idx_orders_user ON dbo.orders(user_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_orders_status' AND object_id=OBJECT_ID('dbo.orders'))
  CREATE INDEX idx_orders_status ON dbo.orders(status);
GO

-- ── order_items ─────────────────────────────────────────────
IF OBJECT_ID('dbo.order_items', 'U') IS NULL
CREATE TABLE dbo.order_items (
  id         uniqueidentifier PRIMARY KEY DEFAULT newid(),
  order_id   uniqueidentifier NULL REFERENCES dbo.orders(id) ON DELETE CASCADE,
  product_id uniqueidentifier NULL REFERENCES dbo.products(id),
  variant_id uniqueidentifier NULL REFERENCES dbo.variants(id),
  quantity   int NOT NULL CONSTRAINT ck_order_items_qty CHECK (quantity > 0),
  unit_price decimal(10,2) NOT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_order_items_order' AND object_id=OBJECT_ID('dbo.order_items'))
  CREATE INDEX idx_order_items_order ON dbo.order_items(order_id);
GO

-- ── cart_items ──────────────────────────────────────────────
IF OBJECT_ID('dbo.cart_items', 'U') IS NULL
CREATE TABLE dbo.cart_items (
  id         uniqueidentifier PRIMARY KEY DEFAULT newid(),
  user_id    uniqueidentifier NOT NULL REFERENCES dbo.profiles(id) ON DELETE CASCADE,
  product_id uniqueidentifier NULL REFERENCES dbo.products(id),
  variant_id uniqueidentifier NOT NULL REFERENCES dbo.variants(id),
  quantity   int DEFAULT 1 CONSTRAINT ck_cart_qty CHECK (quantity > 0),
  created_at datetimeoffset DEFAULT sysdatetimeoffset(),
  CONSTRAINT uq_cart_user_variant UNIQUE (user_id, variant_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_cart_user' AND object_id=OBJECT_ID('dbo.cart_items'))
  CREATE INDEX idx_cart_user ON dbo.cart_items(user_id);
GO

-- ── wishlist_items ──────────────────────────────────────────
IF OBJECT_ID('dbo.wishlist_items', 'U') IS NULL
CREATE TABLE dbo.wishlist_items (
  id         uniqueidentifier PRIMARY KEY DEFAULT newid(),
  user_id    uniqueidentifier NOT NULL REFERENCES dbo.profiles(id) ON DELETE CASCADE,
  product_id uniqueidentifier NOT NULL REFERENCES dbo.products(id),
  created_at datetimeoffset DEFAULT sysdatetimeoffset(),
  CONSTRAINT uq_wishlist_user_product UNIQUE (user_id, product_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_wishlist_user' AND object_id=OBJECT_ID('dbo.wishlist_items'))
  CREATE INDEX idx_wishlist_user ON dbo.wishlist_items(user_id);
GO

-- ── coupons ─────────────────────────────────────────────────
IF OBJECT_ID('dbo.coupons', 'U') IS NULL
CREATE TABLE dbo.coupons (
  id           uniqueidentifier PRIMARY KEY DEFAULT newid(),
  code         nvarchar(255) NOT NULL UNIQUE,
  discount_pct decimal(5,2) NOT NULL,
  max_uses     int,
  used_count   int DEFAULT 0,
  starts_at    datetimeoffset,
  expires_at   datetimeoffset,
  category_id  uniqueidentifier NULL REFERENCES dbo.categories(id),
  product_id   uniqueidentifier NULL REFERENCES dbo.products(id),
  active       bit DEFAULT 1,
  created_at   datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_coupons_active' AND object_id=OBJECT_ID('dbo.coupons'))
  CREATE INDEX idx_coupons_active ON dbo.coupons(active);
GO

-- ── offline_sales ───────────────────────────────────────────
IF OBJECT_ID('dbo.offline_sales', 'U') IS NULL
CREATE TABLE dbo.offline_sales (
  id             uniqueidentifier PRIMARY KEY DEFAULT newid(),
  variant_id     uniqueidentifier NULL REFERENCES dbo.variants(id),
  product_id     uniqueidentifier NULL REFERENCES dbo.products(id),
  sold_by        uniqueidentifier NULL REFERENCES dbo.profiles(id),
  quantity       int NOT NULL CONSTRAINT ck_offline_qty CHECK (quantity > 0),
  unit_price     decimal(10,2) NOT NULL,
  customer_name  nvarchar(max),
  customer_phone nvarchar(64),
  created_at     datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_offline_sales_sold_by' AND object_id=OBJECT_ID('dbo.offline_sales'))
  CREATE INDEX idx_offline_sales_sold_by ON dbo.offline_sales(sold_by);
GO

-- ── notifications ───────────────────────────────────────────
IF OBJECT_ID('dbo.notifications', 'U') IS NULL
CREATE TABLE dbo.notifications (
  id         uniqueidentifier PRIMARY KEY DEFAULT newid(),
  user_id    uniqueidentifier NULL REFERENCES dbo.profiles(id) ON DELETE CASCADE,
  title      nvarchar(max) NOT NULL,
  body       nvarchar(max) NOT NULL,
  [read]     bit DEFAULT 0,
  created_at datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_notifications_user' AND object_id=OBJECT_ID('dbo.notifications'))
  CREATE INDEX idx_notifications_user ON dbo.notifications(user_id, [read]);
GO

-- ── ai_quota_settings (singleton) ───────────────────────────
IF OBJECT_ID('dbo.ai_quota_settings', 'U') IS NULL
CREATE TABLE dbo.ai_quota_settings (
  id             int PRIMARY KEY CONSTRAINT ck_aiq_id CHECK (id = 1),
  image_limit    int NOT NULL DEFAULT 500,
  content_limit  int NOT NULL DEFAULT 2000,
  reset_period   nvarchar(20) NOT NULL DEFAULT 'monthly'
                   CONSTRAINT ck_aiq_period CHECK (reset_period IN ('lifetime','monthly')),
  period_start   datetimeoffset NOT NULL DEFAULT sysdatetimeoffset(),
  images_used    int NOT NULL DEFAULT 0 CONSTRAINT ck_aiq_images CHECK (images_used >= 0),
  content_used   int NOT NULL DEFAULT 0 CONSTRAINT ck_aiq_content CHECK (content_used >= 0),
  updated_at     datetimeoffset DEFAULT sysdatetimeoffset(),
  updated_by     uniqueidentifier NULL REFERENCES dbo.profiles(id)
);
GO

-- ── ai_usage_log ────────────────────────────────────────────
IF OBJECT_ID('dbo.ai_usage_log', 'U') IS NULL
CREATE TABLE dbo.ai_usage_log (
  id          uniqueidentifier PRIMARY KEY DEFAULT newid(),
  usage_type  nvarchar(20) NOT NULL CONSTRAINT ck_aiu_type CHECK (usage_type IN ('image','content')),
  user_id     uniqueidentifier NULL REFERENCES dbo.profiles(id),
  created_at  datetimeoffset DEFAULT sysdatetimeoffset()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_ai_usage_log_type' AND object_id=OBJECT_ID('dbo.ai_usage_log'))
  CREATE INDEX idx_ai_usage_log_type ON dbo.ai_usage_log(usage_type);
GO
