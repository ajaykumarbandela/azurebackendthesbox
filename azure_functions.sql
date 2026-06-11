-- ============================================================
-- T-SQL ports of the Supabase Postgres RPC functions.
-- Implemented as stored procedures (T-SQL has no plpgsql).
-- Re-runnable: each is dropped if it exists, then created.
-- ============================================================

-- ── decrement_variant_stock(variant_id, qty) ───────────────
IF OBJECT_ID('dbo.decrement_variant_stock', 'P') IS NOT NULL DROP PROCEDURE dbo.decrement_variant_stock
GO
CREATE PROCEDURE dbo.decrement_variant_stock
  @variant_id uniqueidentifier,
  @qty int
AS
BEGIN
  SET NOCOUNT ON
  UPDATE dbo.variants
  SET quantity   = CASE WHEN quantity - @qty < 0 THEN 0 ELSE quantity - @qty END,
      sold_count = sold_count + @qty
  WHERE id = @variant_id
END
GO

-- ── increment_coupon_usage(code) ───────────────────────────
IF OBJECT_ID('dbo.increment_coupon_usage', 'P') IS NOT NULL DROP PROCEDURE dbo.increment_coupon_usage
GO
CREATE PROCEDURE dbo.increment_coupon_usage
  @code nvarchar(255)
AS
BEGIN
  SET NOCOUNT ON
  UPDATE dbo.coupons SET used_count = used_count + 1 WHERE code = @code
END
GO

-- ── daily_sales_last_30_days() -> table(date, revenue) ─────
IF OBJECT_ID('dbo.daily_sales_last_30_days', 'P') IS NOT NULL DROP PROCEDURE dbo.daily_sales_last_30_days
GO
CREATE PROCEDURE dbo.daily_sales_last_30_days
AS
BEGIN
  SET NOCOUNT ON
  SELECT
    FORMAT(CAST(created_at AS date), 'dd/MM') AS [date],
    SUM(total_amount) AS revenue
  FROM dbo.orders
  WHERE created_at >= DATEADD(day, -30, SYSDATETIMEOFFSET())
    AND status <> 'cancelled'
  GROUP BY CAST(created_at AS date)
  ORDER BY CAST(created_at AS date)
END
GO

-- ── maybe_reset_ai_quota_period() ──────────────────────────
IF OBJECT_ID('dbo.maybe_reset_ai_quota_period', 'P') IS NOT NULL DROP PROCEDURE dbo.maybe_reset_ai_quota_period
GO
CREATE PROCEDURE dbo.maybe_reset_ai_quota_period
AS
BEGIN
  SET NOCOUNT ON
  UPDATE dbo.ai_quota_settings
  SET images_used = 0,
      content_used = 0,
      period_start = DATEFROMPARTS(YEAR(SYSDATETIMEOFFSET()), MONTH(SYSDATETIMEOFFSET()), 1),
      updated_at = SYSDATETIMEOFFSET()
  WHERE id = 1
    AND reset_period = 'monthly'
    AND (YEAR(period_start) < YEAR(SYSDATETIMEOFFSET())
         OR (YEAR(period_start) = YEAR(SYSDATETIMEOFFSET()) AND MONTH(period_start) < MONTH(SYSDATETIMEOFFSET())))
END
GO

-- ── consume_ai_quota(type, user_id) ────────────────────────
-- Atomically consumes one unit. Returns remaining count via SELECT, or raises
-- an error (THROW) the app maps to a QuotaExceededError.
IF OBJECT_ID('dbo.consume_ai_quota', 'P') IS NOT NULL DROP PROCEDURE dbo.consume_ai_quota
GO
CREATE PROCEDURE dbo.consume_ai_quota
  @p_type nvarchar(20),
  @p_user_id uniqueidentifier = NULL
AS
BEGIN
  SET NOCOUNT ON
  IF @p_type NOT IN ('image', 'content')
  BEGIN
    ;THROW 50001, 'Invalid usage type', 1
  END

  EXEC dbo.maybe_reset_ai_quota_period

  BEGIN TRANSACTION
  DECLARE @images_used int, @image_limit int, @content_used int, @content_limit int, @remaining int

  SELECT @images_used = images_used, @image_limit = image_limit,
         @content_used = content_used, @content_limit = content_limit
  FROM dbo.ai_quota_settings WITH (UPDLOCK, ROWLOCK)
  WHERE id = 1

  IF @@ROWCOUNT = 0
  BEGIN
    ROLLBACK TRANSACTION;
    THROW 50002, 'AI quota settings not configured', 1
  END

  IF @p_type = 'image'
  BEGIN
    IF @images_used >= @image_limit
    BEGIN
      ROLLBACK TRANSACTION;
      THROW 50003, 'AI image quota exhausted', 1
    END
    UPDATE dbo.ai_quota_settings SET images_used = images_used + 1, updated_at = SYSDATETIMEOFFSET() WHERE id = 1
    SET @remaining = @image_limit - @images_used - 1
  END
  ELSE
  BEGIN
    IF @content_used >= @content_limit
    BEGIN
      ROLLBACK TRANSACTION;
      THROW 50004, 'AI content quota exhausted', 1
    END
    UPDATE dbo.ai_quota_settings SET content_used = content_used + 1, updated_at = SYSDATETIMEOFFSET() WHERE id = 1
    SET @remaining = @content_limit - @content_used - 1
  END

  INSERT INTO dbo.ai_usage_log (id, usage_type, user_id) VALUES (NEWID(), @p_type, @p_user_id)
  COMMIT TRANSACTION

  SELECT @p_type AS [type], @remaining AS remaining
END
GO

-- ── reset_ai_quota_period() (manual) ───────────────────────
IF OBJECT_ID('dbo.reset_ai_quota_period', 'P') IS NOT NULL DROP PROCEDURE dbo.reset_ai_quota_period
GO
CREATE PROCEDURE dbo.reset_ai_quota_period
AS
BEGIN
  SET NOCOUNT ON
  UPDATE dbo.ai_quota_settings
  SET images_used = 0,
      content_used = 0,
      period_start = CASE WHEN reset_period = 'monthly'
                          THEN DATEFROMPARTS(YEAR(SYSDATETIMEOFFSET()), MONTH(SYSDATETIMEOFFSET()), 1)
                          ELSE period_start END,
      updated_at = SYSDATETIMEOFFSET()
  WHERE id = 1
END
GO
