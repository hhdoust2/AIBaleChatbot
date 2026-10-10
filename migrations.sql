-- این اسکیمای اولیه‌ی دیتابیس D1 است.
-- نکته مهم: عبارت‌های ON CONFLICT در index.js فقط زمانی کار می‌کنند
-- که روی ستون مربوطه UNIQUE یا PRIMARY KEY تعریف شده باشد.
-- اگر جدول‌ها بدون این محدودیت‌ها ساخته شده باشند، INSERT ... ON CONFLICT
-- خطا می‌دهد و در نتیجه انتخاب مدل یا ذخیره کلید هرگز عملاً ثبت نمی‌شود.

CREATE TABLE IF NOT EXISTS user_memory (
  user_id         INTEGER PRIMARY KEY,
  selected_model  TEXT,
  custom_endpoint TEXT,
  summary         TEXT,
  recent_messages TEXT
);

CREATE TABLE IF NOT EXISTS user_keys (
  user_id  INTEGER NOT NULL,
  provider TEXT NOT NULL,
  api_key  TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- ---------- پروایدرها و مدل‌های اختصاصی هر کاربر (اضافه‌شده از داخل ربات) ----------
-- برای دیتابیس موجود فقط همین دو جدول را اجرا کنید:
--   wrangler d1 execute bot_db --remote --file=migrations.sql
-- (دستورهای CREATE TABLE IF NOT EXISTS برای جدول‌های قبلی بی‌اثرند.)

CREATE TABLE IF NOT EXISTS user_providers (
  user_id       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  chat_endpoint TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS user_models (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  provider  TEXT NOT NULL,
  model_id  TEXT NOT NULL,
  name      TEXT NOT NULL,
  UNIQUE (user_id, provider, model_id)
);
