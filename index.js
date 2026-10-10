import { Bot, InlineKeyboard, InputFile } from "grammy";
import config from "./config.js";
import { extractText, getDocumentProxy } from "unpdf";

// ==========================================
// ۱. توابع رمزنگاری (AES-GCM با کلید مشتق‌شده از ENCRYPTION_KEY)
// ==========================================
async function deriveKey(secret, usage) {
  if (!secret) {
    throw new Error("ENCRYPTION_KEY تنظیم نشده است. بدون این مقدار امکان رمزنگاری/رمزگشایی امن وجود ندارد.");
  }
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("tg-bot-aes-key-v1") },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function encryptText(plainText, secretKey) {
  if (!plainText) return "";
  const key = await deriveKey(secretKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plainText));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64(combined);
}

// در صورت شکست رمزگشایی (مثلاً تغییر ENCRYPTION_KEY یا داده خراب) مقدار null برمی‌گرداند
// تا فراخوان بتواند تشخیص دهد و حافظه مربوطه را ریست کند، به‌جای کرش کردن کل درخواست.
async function decryptText(cipherText, secretKey) {
  if (!cipherText) return "";
  try {
    const key = await deriveKey(secretKey, "decrypt");
    const data = base64ToBytes(cipherText);
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.error("decryptText failed:", err.message);
    return null;
  }
}

// ==========================================
// ۲. تابع Fetch با مدیریت Timeout + تبدیل ArrayBuffer به Base64 (chunked)
// ==========================================
async function fetchWithTimeout(url, options, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    if (error.name === "AbortError") {
      throw new Error(`زمان پاسخ‌دهی سرور بیش از حد طول کشید (بیش از ${Math.round(timeout / 1000)} ثانیه). لطفاً دوباره امتحان کنید.`);
    }
    throw error;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  return bytesToBase64(bytes);
}

// آدرس API بله (سازگار با ساختار Bot API تلگرام)
const BALE_API_ROOT = "https://tapi.bale.ai";

function buildFileUrl(env, filePath) {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return `${BALE_API_ROOT}/file/bot${env.BOT_TOKEN}/${filePath.replace(/^\/+/, "")}`;
}

// دانلود فایل از بله (عکس/سند/صوت) — همیشه سمت سرور خودمان، هرگز لینک حاوی BOT_TOKEN را جای دیگری نمی‌فرستیم
async function downloadBaleFile(fileId, ctx) {
  const file = await ctx.api.getFile(fileId);
  if (!file?.file_path) throw new Error("مسیر فایل از بله دریافت نشد.");
  const res = await fetchWithTimeout(buildFileUrl(ctx.env, file.file_path), {}, 30000);
  if (!res.ok) throw new Error(`دانلود فایل از بله ناموفق بود (کد ${res.status}).`);
  const buffer = await res.arrayBuffer();
  const cleanPath = file.file_path.split("?")[0];
  const filename = cleanPath.split("/").pop() || "file";
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  return { buffer, filename, ext };
}

const DOCUMENT_TEXT_LIMIT = 15000;
const TEXT_FILE_EXTENSIONS = ["txt", "md", "csv", "json", "log", "yaml", "yml", "js", "py", "html", "css", "xml", "ts"];

// استخراج متن از فایل (PDF یا فایل‌های متنی ساده). برای فرمت‌های پشتیبانی‌نشده خطا می‌دهد.
async function extractDocumentText(buffer, mimeType, filename, ext) {
  let raw;
  if (mimeType === "application/pdf" || ext === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    raw = text;
  } else if ((mimeType && mimeType.startsWith("text/")) || TEXT_FILE_EXTENSIONS.includes(ext)) {
    raw = new TextDecoder("utf-8").decode(buffer);
  } else {
    throw new Error(`فرمت فایل «.${ext || "?"}» فعلاً پشتیبانی نمی‌شود. فرمت‌های پشتیبانی‌شده: PDF و فایل‌های متنی (txt, md, csv, json, ...).`);
  }

  raw = (raw || "").trim();
  if (!raw) throw new Error("متنی از این فایل استخراج نشد (شاید اسکن‌شده یا خالی باشد).");

  if (raw.length > DOCUMENT_TEXT_LIMIT) {
    raw = raw.slice(0, DOCUMENT_TEXT_LIMIT) + "\n...[متن به‌خاطر طولانی بودن کوتاه شد]";
  }
  return raw;
}

// تبدیل صوت به متن با Whisper روی Groq

function getFileExtension(mimeType) {
  const mimeMap = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/opus': 'opus',
    'audio/flac': 'flac',
    'video/mp4': 'mp4',
    'video/mpeg': 'mpeg',
    'video/webm': 'webm'
  };
  
  return mimeMap[mimeType?.toLowerCase()] || 'ogg';
}

async function transcribeAudio(userId, buffer, mimeType, filename, env) {
  const apiKey = (await getUserStoredKey(userId, "groq", env)) || env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("برای تبدیل صوت به متن باید کلید Groq تنظیم شده باشد (`groq your_api_key`).");
  }

  // اضافه کردن این قسمت
  const actualMimeType = mimeType || "audio/ogg";
  const extension = getFileExtension(actualMimeType);
  const actualFilename = filename || `audio.${extension}`;

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: actualMimeType }), actualFilename);
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");

  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  }, 45000); // مستقیماً عدد را بنویسید

  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("سهمیه/نرخ درخواست Groq تمام شده. کمی صبر کنید و دوباره امتحان کنید.");
    }
    const errText = await res.text().catch(() => "");
    throw new Error(`خطای تبدیل صوت به متن (کد ${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.text || "";
}


// ==========================================
// ۳. کلید یکتا برای مدل (چون id به‌تنهایی ممکن است بین چند پروایدر تکراری باشد)
// ==========================================
function getModelKey(m) {
  return `${m.provider}:${m.id}`;
}

// ==========================================
// ۴. دریافت API Key
// ==========================================
// فقط کلید ذخیره‌شده‌ی خودِ کاربر را برمی‌گرداند؛ بدون fallback به کلید env.
// این تابع مخصوص جایی است که کاربر یک اندپوینت دلخواه (سرور شخص ثالث) وارد کرده،
// چون فرستادن کلید env به یک سرور ناشناس هم لو رفتن کلید و هم ریسک SSRF/سوءاستفاده دارد.
async function getUserStoredKey(userId, provider, env) {
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT api_key FROM user_keys WHERE user_id = ? AND provider = ?")
    .bind(userId, provider).first();
  if (!row?.api_key) return null;
  const key = await decryptText(row.api_key, env.ENCRYPTION_KEY);
  return key || null;
}

// کلید مشترک (Secret داخل Cloudflare) فقط برای پروایدرهای داخلی؛ برای پروایدر اختصاصی کاربر هرگز
function getEnvKeyForProvider(provider, env) {
  if (!Object.hasOwn(config.providers, provider)) return null;
  const envKeyMap = {
    google: env.GEMINI_API_KEY,
    openai: env.OPENAI_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
    groq: env.GROQ_API_KEY,
    mistral: env.MISTRAL_API_KEY,
  };
  return envKeyMap[provider] || null;
}

async function getApiKeyForProvider(userId, provider, env) {
  const userKey = await getUserStoredKey(userId, provider, env);
  if (userKey) return userKey;
  // امنیت: برای پروایدرهای اضافه‌شده توسط کاربر هرگز از کلید env استفاده نمی‌شود
  // (وگرنه با ساختن پروایدری به نام openai/mistral و اندپوینت دلخواه، کلید env لو می‌رفت).
  return getEnvKeyForProvider(provider, env);
}

// ==========================================
// ۴-ب. پروایدرها و مدل‌های اضافه‌شده توسط کاربر (ذخیره در D1، جدا برای هر کاربر)
// ==========================================
const USER_PROVIDER_LIMIT = 10;
const USER_MODEL_LIMIT = 40; // سقف دکمه‌های اینلاین؛ ۴۰ + مدل‌های config جا دارد
const PROVIDER_NAME_RE = /^[a-z0-9_-]{2,30}$/;
const MODEL_ID_RE = /^[\w.:/@+-]{1,100}$/;
const RESERVED_NAMES = new Set([
  "tavily", "endpoint", "addprovider", "addmodel", "delprovider", "delmodel",
  "list", "models", "clear", "reset", "start"
]);

function capitalize(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}

// نام نمایشی مدل همیشه با پیشوند پروایدر است ("Groq * llama-3.3-70b-versatile")
function modelLabel(provider, name) {
  const prefix = `${capitalize(provider)} * `;
  return name.startsWith(prefix) ? name : prefix + name;
}

function stripModelPrefix(provider, label) {
  const prefix = `${capitalize(provider)} * `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

// وضعیت کلید یک پروایدر برای این کاربر: "user" (کلید شخصی) | "shared" (Secret ربات) | "missing" | null (نامشخص)
async function getKeyStatus(userId, provider, env) {
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok FROM user_keys WHERE user_id = ? AND provider = ?")
      .bind(userId, provider).first();
    if (row) return "user";
    return getEnvKeyForProvider(provider, env) ? "shared" : "missing";
  } catch (err) {
    console.error("getKeyStatus failed:", err.message);
    return null;
  }
}

// md=true: دستور داخل بک‌تیک می‌آید تا در مارک‌داون بله آندرلاین خراب نشود
function keyStatusText(status, provider, md = false) {
  if (status === "user") return "🔑 کلید شما برای این پروایدر ثبت شده است.";
  if (status === "shared") return "🔑 از کلید مشترک ربات برای این پروایدر استفاده می‌شود.";
  if (status === "missing") {
    const cmd = `${provider} your_api_key`;
    return `⚠️ برای این پروایدر هنوز کلید ثبت نکرده‌اید. بنویسید:\n${md ? "`" + cmd + "`" : cmd}`;
  }
  return "";
}

// اندپوینت پروایدر باید https و عمومی باشد (جلوگیری از اشاره به آدرس‌های محلی/داخلی)
function validateProviderEndpoint(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("آدرس اندپوینت نامعتبر است.");
  }
  if (u.protocol !== "https:") throw new Error("اندپوینت باید با https شروع شود.");
  if (u.username || u.password) throw new Error("آدرس اندپوینت نباید شامل نام‌کاربری/رمز باشد.");
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[")) throw new Error("استفاده از آدرس IPv6 مجاز نیست؛ از نام دامنه استفاده کنید.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("آدرس محلی/داخلی مجاز نیست.");
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      throw new Error("آدرس IP محلی/داخلی مجاز نیست.");
    }
  }
  return raw;
}

async function getUserProvider(userId, name, env) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT chat_endpoint FROM user_providers WHERE user_id = ? AND name = ?")
      .bind(userId, name).first();
    return row ? { type: "openai_compatible", chat_endpoint: row.chat_endpoint } : null;
  } catch (err) {
    console.error("getUserProvider failed:", err.message);
    return null;
  }
}

// پروایدر داخلی (config.js) یا پروایدر اضافه‌شده توسط خود کاربر
async function getProviderInfo(userId, provider, env) {
  if (Object.hasOwn(config.providers, provider)) return config.providers[provider];
  return getUserProvider(userId, provider, env);
}

async function getUserModels(userId, env) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, provider, model_id, name FROM user_models WHERE user_id = ? ORDER BY id"
    ).bind(userId).all();
    return (results || []).map(r => ({
      rowId: r.id, name: modelLabel(r.provider, r.name), id: r.model_id, provider: r.provider, capability: "chat", rps: null
    }));
  } catch (err) {
    // اگر migrations.sql هنوز اجرا نشده باشد، ربات با مدل‌های config.js به کار خود ادامه می‌دهد
    console.error("getUserModels failed:", err.message);
    return [];
  }
}

// اول مدل‌های config.js، بعد مدل‌های کاربر؛ در نبودِ هر دو به مدل پیش‌فرض برمی‌گردد
async function findModel(userId, modelKey, env) {
  const builtin = config.models.find(m => getModelKey(m) === modelKey);
  if (builtin) return builtin;
  const custom = (await getUserModels(userId, env)).find(m => getModelKey(m) === modelKey);
  return custom || config.models[0];
}

async function saveUserKey(userId, provider, apiKey, env) {
  const encryptedKey = await encryptText(apiKey, env.ENCRYPTION_KEY);
  await env.DB.prepare(
    `INSERT INTO user_keys (user_id, provider, api_key) VALUES (?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET api_key = excluded.api_key`
  ).bind(userId, provider, encryptedKey).run();
}

const MANAGE_HELP =
  "📌 مدیریت پروایدر و مدل (provider = نام پروایدر، مثلاً groq یا نامی که خودتان ساخته‌اید):\n" +
  "addprovider provider https://api.example.com/v1/chat/completions [کلید]\n" +
  "addmodel provider model-id [نام نمایشی]\n" +
  "   مثال: addmodel groq llama-3.3-70b-versatile\n" +
  "delprovider provider\n" +
  "delmodel provider model-id\n" +
  "provider کلید ← ثبت/تغییر کلید آن پروایدر\n" +
  "/list ← نمایش پروایدرها، کلیدها و مدل‌های هر پروایدر";

// پیام‌های مدیریتی متنی؛ اگر پیام یکی از این دستورها بود true برمی‌گرداند
async function handleProviderModelCommand(ctx, text) {
  const userId = ctx.from.id;
  const env = ctx.env;
  const parts = text.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  if (!cmd) return false;

  const isManageCmd = ["addprovider", "addmodel", "delprovider", "delmodel"].includes(cmd);
  const isCustomKeyMsg = !isManageCmd && parts.length === 2 && PROVIDER_NAME_RE.test(cmd) &&
    !Object.hasOwn(config.providers, cmd) && !RESERVED_NAMES.has(cmd) && !(cmd in Object.prototype);
  if (!isManageCmd && !isCustomKeyMsg) return false;

  let hasKey = false;
  try {
    // ---- افزودن پروایدر ----
    if (cmd === "addprovider") {
      const name = parts[1]?.toLowerCase();
      const endpoint = parts[2];
      const apiKey = parts.slice(3).join(" ").trim();
      hasKey = !!apiKey;
      if (!name || !endpoint) {
        await ctx.reply("❌ فرمت درست:\naddprovider provider https://api.example.com/v1/chat/completions [کلید]");
        return true;
      }
      if (!PROVIDER_NAME_RE.test(name) || name in Object.prototype) {
        await ctx.reply("❌ نام پروایدر باید ۲ تا ۳۰ کاراکتر و فقط شامل حروف انگلیسی کوچک، عدد، - و _ باشد.");
        return true;
      }
      if (Object.hasOwn(config.providers, name) || RESERVED_NAMES.has(name)) {
        await ctx.reply(`❌ نام «${name}» رزرو است. نام دیگری انتخاب کنید.`);
        return true;
      }
      try {
        validateProviderEndpoint(endpoint);
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
        return true;
      }

      const existing = await getUserProvider(userId, name, env);
      if (!existing) {
        const { c } = await env.DB.prepare("SELECT COUNT(*) AS c FROM user_providers WHERE user_id = ?").bind(userId).first();
        if (c >= USER_PROVIDER_LIMIT) {
          await ctx.reply(`❌ حداکثر ${USER_PROVIDER_LIMIT} پروایدر می‌توانید داشته باشید. ابتدا یکی را با delprovider حذف کنید.`);
          return true;
        }
      }
      await env.DB.prepare(
        `INSERT INTO user_providers (user_id, name, chat_endpoint) VALUES (?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET chat_endpoint = excluded.chat_endpoint`
      ).bind(userId, name, endpoint).run();
      if (apiKey) await saveUserKey(userId, name, apiKey, env);

      await ctx.reply(
        `✅ پروایدر «${name}» ${existing ? "به‌روز شد" : "ذخیره شد"}.\n` +
        (apiKey
          ? "🔑 کلید هم ذخیره شد (پیام شما برای امنیت پاک می‌شود).\n"
          : `برای ثبت کلید بنویسید:\n${name} your_api_key\n`) +
        `حالا مدل اضافه کنید:\naddmodel ${name} model-id`
      );
      return true;
    }

    // ---- افزودن مدل (به پروایدر داخلی یا پروایدر خودِ کاربر) ----
    if (cmd === "addmodel") {
      const provider = parts[1]?.toLowerCase();
      const modelId = parts[2];
      const displayName = parts.slice(3).join(" ").trim().slice(0, 60);
      if (!provider || !modelId) {
        await ctx.reply("❌ فرمت درست:\naddmodel provider model-id [نام نمایشی]\nمثال:\naddmodel groq llama-3.3-70b-versatile\n(provider = نام پروایدر؛ نام‌ها را با /list ببینید)");
        return true;
      }
      if (!MODEL_ID_RE.test(modelId)) {
        await ctx.reply("❌ شناسه‌ی مدل نامعتبر است (فقط حروف، عدد و . _ - : / @ + مجاز است).");
        return true;
      }
      const providerInfo = await getProviderInfo(userId, provider, env);
      if (!providerInfo) {
        const { results } = await env.DB.prepare("SELECT name FROM user_providers WHERE user_id = ? ORDER BY name").bind(userId).all();
        const names = [...Object.keys(config.providers), ...(results || []).map(r => r.name)];
        await ctx.reply(
          `❌ پروایدر «${provider}» وجود ندارد.\n` +
          `پروایدرهای موجود: ${names.join(", ")}\n` +
          `برای پروایدر جدید ابتدا addprovider را بزنید.`
        );
        return true;
      }
      const modelKey = getModelKey({ provider, id: modelId });
      if (config.models.some(m => getModelKey(m) === modelKey)) {
        await ctx.reply("ℹ️ این مدل از قبل در لیست پیش‌فرض ربات وجود دارد (/models).");
        return true;
      }
      const existing = await env.DB.prepare(
        "SELECT id FROM user_models WHERE user_id = ? AND provider = ? AND model_id = ?"
      ).bind(userId, provider, modelId).first();
      if (!existing) {
        const { c } = await env.DB.prepare("SELECT COUNT(*) AS c FROM user_models WHERE user_id = ?").bind(userId).first();
        if (c >= USER_MODEL_LIMIT) {
          await ctx.reply(`❌ حداکثر ${USER_MODEL_LIMIT} مدل می‌توانید اضافه کنید. ابتدا یکی را با delmodel حذف کنید.`);
          return true;
        }
      }
      const name = displayName || modelId;
      await env.DB.prepare(
        `INSERT INTO user_models (user_id, provider, model_id, name) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, provider, model_id) DO UPDATE SET name = excluded.name`
      ).bind(userId, provider, modelId, name).run();
      const status = await getKeyStatus(userId, provider, env);
      await ctx.reply([
        `✅ مدل ${existing ? "به‌روز شد" : "اضافه شد"}:`,
        modelLabel(provider, name),
        `🔌 پروایدر: ${provider}`,
        keyStatusText(status, provider),
        "از /models می‌توانید آن را انتخاب کنید."
      ].filter(Boolean).join("\n"));
      return true;
    }

    // ---- حذف پروایدر (همراه مدل‌ها و کلید همان پروایدر) ----
    if (cmd === "delprovider") {
      const name = parts[1]?.toLowerCase();
      if (!name) {
        await ctx.reply("❌ فرمت درست:\ndelprovider provider");
        return true;
      }
      if (Object.hasOwn(config.providers, name)) {
        await ctx.reply("❌ پروایدرهای پیش‌فرض ربات قابل حذف نیستند (فقط می‌توانید کلیدشان را با /reset ریست کنید).");
        return true;
      }
      const existing = await getUserProvider(userId, name, env);
      if (!existing) {
        await ctx.reply(`❌ پروایدر «${name}» در لیست شما نیست.`);
        return true;
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM user_models WHERE user_id = ? AND provider = ?").bind(userId, name),
        env.DB.prepare("DELETE FROM user_keys WHERE user_id = ? AND provider = ?").bind(userId, name),
        env.DB.prepare("DELETE FROM user_providers WHERE user_id = ? AND name = ?").bind(userId, name),
        env.DB.prepare("UPDATE user_memory SET selected_model = NULL WHERE user_id = ? AND substr(selected_model, 1, ?) = ?")
          .bind(userId, name.length + 1, `${name}:`)
      ]);
      await ctx.reply(`🗑 پروایدر «${name}» به‌همراه مدل‌ها و کلیدش حذف شد.`);
      return true;
    }

    // ---- حذف مدل ----
    if (cmd === "delmodel") {
      const provider = parts[1]?.toLowerCase();
      const modelId = parts[2];
      if (!provider || !modelId) {
        await ctx.reply("❌ فرمت درست:\ndelmodel provider model-id");
        return true;
      }
      const modelKey = getModelKey({ provider, id: modelId });
      if (config.models.some(m => getModelKey(m) === modelKey)) {
        await ctx.reply("❌ مدل‌های پیش‌فرض ربات قابل حذف نیستند.");
        return true;
      }
      const results = await env.DB.batch([
        env.DB.prepare("DELETE FROM user_models WHERE user_id = ? AND provider = ? AND model_id = ?").bind(userId, provider, modelId),
        env.DB.prepare("UPDATE user_memory SET selected_model = NULL WHERE user_id = ? AND selected_model = ?").bind(userId, modelKey)
      ]);
      if (!results[0]?.meta?.changes) {
        await ctx.reply("❌ چنین مدلی در لیست شما نیست. لیست را با /list ببینید.");
        return true;
      }
      await ctx.reply(`🗑 مدل «${provider}:${modelId}» حذف شد.`);
      return true;
    }

    // ---- ثبت/تغییر کلید پروایدرِ کاربر: "نام کلید" ----
    if (isCustomKeyMsg) {
      const provider = await getUserProvider(userId, cmd, env);
      if (!provider) return false; // پروایدر نیست → پیام یک چت عادی است
      const apiKey = parts[1].trim();
      hasKey = true;
      await saveUserKey(userId, cmd, apiKey, env);
      await ctx.reply(`🔑 کلید پروایدر ${cmd} با موفقیت ذخیره شد.`);
      return true;
    }
    return false;
  } catch (err) {
    console.error("provider/model command error:", err);
    const msg = /no such table/i.test(err.message || "")
      ? "جدول‌های جدید دیتابیس ساخته نشده‌اند. مدیر ربات باید migrations.sql را روی D1 اجرا کند."
      : (err.message || "خطای ناشناخته");
    await ctx.reply(`❌ خطا: ${msg}`).catch(() => {});
    return true;
  } finally {
    // پیامی که کلید داخلش بود، در هر حالتی از چت پاک شود
    if (hasKey) await ctx.deleteMessage().catch(() => {});
  }
}

// محتوای پیام (رشته یا آرایه‌ی text/image_url به سبک OpenAI) را به فرمت parts گوگل تبدیل می‌کند
function toGeminiParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === "text") return { text: part.text || "" };
      if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        const match = url.match(/^data:(.+?);base64,(.+)$/);
        if (match) {
          return { inline_data: { mime_type: match[1], data: match[2] } };
        }
        return { text: "[تصویر پشتیبانی نشد]" };
      }
      return { text: "" };
    });
  }
  return [{ text: String(content) }];
}

// ==========================================
// ۵. فراخوانی API مدل‌ها
// ==========================================
const MAX_TOKENS = 2048; // جلوگیری از رزرو خودکار حداکثر ظرفیت مدل (که باعث خطای اعتبار/کردیت می‌شود)
const AI_TIMEOUT = 45000; // برخی مدل‌ها (خصوصاً reasoning) بیش از ۱۵ ثانیه‌ی پیش‌فرض طول می‌کشند

async function callAIProvider(userId, modelKey, messages, env, userEndpoint) {
  const modelInfo = await findModel(userId, modelKey, env);
  const providerInfo = await getProviderInfo(userId, modelInfo.provider, env);
  if (!providerInfo) {
    throw new Error(`پروایدر «${modelInfo.provider}» پیدا نشد. مدل دیگری از /models انتخاب کنید.`);
  }

  if (userEndpoint) {
    // فقط با کلید خودِ کاربر برای همان پروایدر (نه کلید env، نه کلید یک پروایدر دیگر)
    const userKey = await getUserStoredKey(userId, modelInfo.provider, env);
    if (!userKey) {
      throw new Error(`برای استفاده از اندپوینت اختصاصی، ابتدا کلید API خودتان برای پروایدر «${modelInfo.provider}» را ثبت کنید.`);
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(userEndpoint);
    } catch {
      throw new Error("آدرس اندپوینت اختصاصی نامعتبر است.");
    }
    if (parsedUrl.protocol !== "https:") {
      throw new Error("اندپوینت اختصاصی باید با https باشد.");
    }
    const res = await fetchWithTimeout(userEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${userKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelInfo.id, messages, max_tokens: MAX_TOKENS })
    }, AI_TIMEOUT);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`اندپوینت اختصاصی خطا داد (کد ${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "پاسخی از اندپوینت اختصاصی دریافت نشد.";
  }

  const apiKey = await getApiKeyForProvider(userId, modelInfo.provider, env);

  if (providerInfo.type === "google") {
    if (!apiKey) throw new Error("کلید API گوگل تنظیم نشده است.");
    const endpoint = providerInfo.chat_endpoint.replace("{model}", modelInfo.id).replace("{key}", apiKey);
    const systemMsg = messages.find(m => m.role === "system");
    const contents = messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m.content) }));

    const payload = {
      contents,
      generationConfig: { maxOutputTokens: MAX_TOKENS },
      ...(systemMsg && { system_instruction: { parts: [{ text: typeof systemMsg.content === "string" ? systemMsg.content : "" }] } })
    };

    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, AI_TIMEOUT);
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error("سهمیه‌ی رایگان کلید API گوگل شما تمام شده. کمی صبر کنید یا Billing را روی پروژه‌ی گوگل‌کلاود فعال کنید.");
      }
      const errText = await res.text().catch(() => "");
      throw new Error(`خطای گوگل API (کد ${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "خطای گوگل API");
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "پاسخی از گوگل دریافت نشد.";
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchWithTimeout(providerInfo.chat_endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: modelInfo.id, messages, max_tokens: MAX_TOKENS })
  }, AI_TIMEOUT);
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error(`سهمیه/نرخ درخواست پروایدر ${modelInfo.provider} تمام شده. کمی صبر کنید و دوباره امتحان کنید.`);
    }
    const errText = await res.text().catch(() => "");
    throw new Error(`خطای پروایدر ${modelInfo.provider} (کد ${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || `خطای پروایدر ${modelInfo.provider}`);
  return data.choices?.[0]?.message?.content || "خطایی در دریافت پاسخ رخ داد.";
}

// ارسال پیام طولانی به‌صورت چندتکه (محدودیت پیام: ۴۰۹۶ کاراکتر)
async function replyLong(ctx, text, extra = {}) {
  const CHUNK = 3800;
  const safeText = text && text.length > 0 ? text : "⚠️ پاسخ خالی دریافت شد.";
  if (safeText.length <= CHUNK) {
    return ctx.reply(safeText, extra);
  }
  for (let i = 0; i < safeText.length; i += CHUNK) {
    const isLast = i + CHUNK >= safeText.length;
    await ctx.reply(safeText.slice(i, i + CHUNK), isLast ? extra : {});
  }
}

// بلاک‌های کد (```...```) را از باقیِ متن جدا می‌کند تا هرکدام جداگانه و با فرمت مناسب ارسال شوند
function splitCodeBlocks(text) {
  const regex = /```(\w+)?\n?([\s\S]*?)```/g;
  const segments = [];
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", lang: match[1] || "", content: match[2] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments;
}

// تبدیل مارک‌داون معمول مدل‌ها به مارک‌داون بله (بله برای بولد از یک ستاره استفاده می‌کند)
function toBaleMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*");
}

// پاسخ را می‌فرستد؛ اگر شامل بلاک کد باشد، هر بلاک کد را جداگانه (داخل ```) می‌فرستد
// تا در بله به‌صورت کد نمایش داده شود و کپی کردنش راحت باشد.
async function replySmart(ctx, text) {
  const segments = splitCodeBlocks(text).filter(s => s.content.trim().length > 0);
  if (!segments.length) {
    return ctx.reply("⚠️ پاسخ خالی دریافت شد.");
  }

  const CODE_CHUNK = 3500;
  for (const seg of segments) {
    if (seg.type === "code") {
      const raw = seg.content.trim();
      for (let i = 0; i < raw.length; i += CODE_CHUNK) {
        await ctx.reply("```\n" + raw.slice(i, i + CODE_CHUNK) + "\n```");
      }
    } else {
      await replyLong(ctx, toBaleMarkdown(seg.content.trim()));
    }
  }
}

// ==========================================
// ۶. کیبورد انتخاب مدل (فقط همین‌جا از دکمه‌ی شیشه‌ای استفاده می‌شود، چون لیست انتخابی است)
// ==========================================
async function getModelsKeyboard(userId, env) {
  const keyboard = new InlineKeyboard();
  const row = env.DB ? await env.DB.prepare("SELECT selected_model FROM user_memory WHERE user_id = ?").bind(userId).first() : null;
  const selectedModel = row?.selected_model || getModelKey(config.models[0]);

  config.models.forEach((m, idx) => {
    const label = getModelKey(m) === selectedModel ? `✅ ${m.name}` : m.name;
    keyboard.text(label, `setmod_${idx}`).row();
  });
  // مدل‌های اضافه‌شده توسط کاربر (با id ردیف دیتابیس، تا با اضافه/حذف شدن مدل‌ها دکمه‌ها جابه‌جا نشوند)
  const userModels = await getUserModels(userId, env);
  userModels.forEach(m => {
    const label = getModelKey(m) === selectedModel ? `✅ ${m.name}` : m.name;
    keyboard.text(label, `setumod_${m.rowId}`).row();
  });
  return keyboard;
}

// مدل ثابت و سبک برای خلاصه‌سازی تاریخچه (مستقل از مدلی که کاربر برای چت انتخاب کرده)
const SUMMARY_MODEL_KEY = getModelKey(config.models[0]);
const HISTORY_LIMIT = 10;

function messageToPlainText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const textPart = m.content.find(p => p.type === "text");
    return textPart?.text || "[تصویر]";
  }
  return "";
}

// پیام‌های قدیمی که در حال حذف شدن از تاریخچه‌اند را با خلاصه‌ی قبلی ترکیب می‌کند.
// در صورت هر خطایی (کلید نبودن، خطای پروایدر و ...) خلاصه‌ی قبلی را بدون تغییر برمی‌گرداند
// تا خلاصه‌سازی هرگز باعث خراب شدن چت اصلی نشود.
async function summarizeHistory(userId, previousSummary, oldMessages, env) {
  if (!oldMessages.length) return previousSummary;
  const historyText = oldMessages
    .map(m => `${m.role === "user" ? "کاربر" : "دستیار"}: ${messageToPlainText(m)}`)
    .join("\n");

  const prompt = [
    {
      role: "system",
      content: "خلاصه‌ی قبلی گفتگو و بخش جدیدی از گفتگو به تو داده می‌شود. یک خلاصه‌ی به‌روزشده، کوتاه (حداکثر ۶ جمله) و به فارسی از نکات و اطلاعات مهم کل گفتگو بنویس. فقط متن خلاصه را برگردان."
    },
    {
      role: "user",
      content: `خلاصه‌ی قبلی:\n${previousSummary || "(هیچ)"}\n\nبخش جدید گفتگو:\n${historyText}`
    }
  ];

  try {
    const result = await callAIProvider(userId, SUMMARY_MODEL_KEY, prompt, env, null);
    return result?.trim() || previousSummary;
  } catch (err) {
    console.error("summarizeHistory failed:", err.message);
    return previousSummary;
  }
}

// عبارت جستجو را به انگلیسی ترجمه می‌کند تا نتایج جستجو محدود به منابع فارسی/داخلی نشوند.
// در صورت خطا همان متن اصلی استفاده می‌شود (جستجو خراب نمی‌شود، فقط ممکن است نتایج محدودتر باشند).
async function translateToEnglish(userId, text, env) {
  try {
    const prompt = [
      { role: "system", content: "متن زیر را به انگلیسیِ کوتاه و مناسب برای موتور جستجو ترجمه کن. فقط ترجمه را برگردان، بدون هیچ توضیح اضافه." },
      { role: "user", content: text }
    ];
    const result = await callAIProvider(userId, SUMMARY_MODEL_KEY, prompt, env, null);
    return result?.trim() || text;
  } catch (err) {
    console.error("translateToEnglish failed:", err.message);
    return text;
  }
}

// جستجوی خام در Tavily (مستقل از پروایدر/مدل چت کاربر؛ سهمیه‌ی رایگان: ۱۰۰۰ درخواست در ماه)
async function tavilySearch(userId, query, env) {
  const apiKey = (await getUserStoredKey(userId, "tavily", env)) || env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("برای جستجوی وب باید کلید Tavily تنظیم شده باشد. یک کلید رایگان از tavily.com بگیرید و با `tavily your_api_key` ثبت کنید.");
  }

  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: false
    })
  });

  if (!res.ok) {
    if (res.status === 429 || res.status === 432 || res.status === 433) {
      throw new Error("سهمیه‌ی کلید Tavily شما تمام شده است. کمی صبر کنید یا از داشبورد Tavily سهمیه‌تان را بررسی کنید.");
    }
    const errText = await res.text().catch(() => "");
    throw new Error(`خطای جستجوی Tavily (کد ${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.results || [])
    .slice(0, 5)
    .filter(r => r.url)
    .map(r => ({ title: r.title || "", url: r.url, content: (r.content || "").slice(0, 600) }));
}

// نتایج خام جستجو را به یک پاسخ فارسیِ خلاصه و روان تبدیل می‌کند (با مدل ثابت و سبک)
async function synthesizeSearchAnswer(userId, originalQuery, results, env) {
  if (!results.length) return { answer: "نتیجه‌ای برای این جستجو یافت نشد.", sources: [] };

  const context = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nمنبع: ${r.url}`)
    .join("\n\n");

  const prompt = [
    {
      role: "system",
      content: "بر اساس نتایج جستجوی زیر، به فارسیِ روان و خلاصه (حداکثر ۶-۸ جمله) به سوال کاربر پاسخ بده. فقط بر اساس همین نتایج جواب بده و اگر اطلاعات کافی نبود، همین را بگو."
    },
    { role: "user", content: `سوال: ${originalQuery}\n\nنتایج جستجو:\n${context}` }
  ];

  const sources = results.map(r => ({ uri: r.url, title: r.title }));

  try {
    const answer = await callAIProvider(userId, SUMMARY_MODEL_KEY, prompt, env, null);
    return { answer: answer?.trim() || "پاسخی تولید نشد.", sources };
  } catch (err) {
    console.error("synthesizeSearchAnswer failed:", err.message);
    return { answer: "خلاصه‌سازی نتایج با خطا مواجه شد؛ فقط منابع خام یافت‌شده:", sources };
  }
}

async function searchWeb(userId, query, env) {
  const englishQuery = await translateToEnglish(userId, query, env);
  const results = await tavilySearch(userId, englishQuery, env);
  return synthesizeSearchAnswer(userId, query, results, env);
}

// ==========================================
// ۷. ثبت هندلرهای ربات
// ==========================================
function registerHandlers(bot) {
  // دستورها را خودمان از روی متن پیام تشخیص می‌دهیم (بدون وابستگی به entities)
  const commands = {};
  const botCommand = (name, fn) => { commands[name] = fn; };
  const providerList = Object.keys(config.providers).map(p => `\`${p} your_api_key\``).join("\n");

  botCommand("start", async (ctx) => {
    await ctx.reply(
      "👋 *به ربات هوش مصنوعی خوش آمدید!*\n\n" +
      "مستقیماً پیام بدهید تا با مدل فعال چت شود. برای مدیریت از دستورات زیر استفاده کنید:\n\n" +
      "🤖 /models — تغییر مدل هوش مصنوعی\n" +
      "📋 /list — پروایدرها، کلیدها و مدل‌های هر پروایدر\n" +
      "🧹 /clear — پاکسازی حافظه‌ی گفتگو\n" +
      "🔄 /reset — ریست کلیدها و اندپوینت\n\n" +
      "🎨 *ساخت تصویر:* پیام را با «عکس» شروع کنید:\n" +
      "`عکس یک ماشین اسپرت در شب`\n\n" +
      "🔎 *جستجوی وب:* پیام را با «جستجو» شروع کنید (نیاز به کلید Tavily؛ رایگان از tavily.com):\n" +
      "`جستجو آخرین اخبار هوش مصنوعی`\n\n" +
      "🖼 *تحلیل عکس:* فقط عکس بفرستید (با توضیح دلخواه در کپشن).\n" +
      "📄 *تحلیل فایل:* فایل PDF یا متنی (txt, md, csv, json, ...) بفرستید تا خلاصه/تحلیل شود.\n" +
      "🎙 *تبدیل صوت به متن:* ویس یا فایل صوتی بفرستید (نیاز به کلید Groq).\n\n" +
      "📌 *برای ثبت کلید اختصاصی یک پروایدر یا Tavily:*\n" +
      "`provider api_key` یا `tavily api_key`\n" +
      `پروایدرهای پشتیبانی‌شده:\n${providerList}\n\n` +
      "📌 *برای ثبت اندپوینت اختصاصی:*\n" +
      "`endpoint https://your-endpoint.com/v1/chat/completions`\n\n" +
      "➕ *افزودن پروایدر و مدل دلخواه:*\n" +
      "`addprovider provider https://api.example.com/v1/chat/completions your_api_key`\n" +
      "`addmodel provider model-id`\n" +
      "مثال: `addmodel groq llama-3.3-70b-versatile`\n" +
      "`delprovider provider` — `delmodel provider model-id`"
    );
  });

  botCommand("models", async (ctx) => {
    await ctx.reply("🤖 *لطفاً مدل مورد نظر خود را انتخاب کنید:*", {
      reply_markup: await getModelsKeyboard(ctx.from.id, ctx.env)
    });
  });

  botCommand("list", async (ctx) => {
    try {
      const userId = ctx.from.id;
      let userProviderRows = [];
      let keySet = new Set();
      try {
        const [providers, keys] = await Promise.all([
          ctx.env.DB.prepare("SELECT name, chat_endpoint FROM user_providers WHERE user_id = ? ORDER BY name").bind(userId).all(),
          ctx.env.DB.prepare("SELECT provider FROM user_keys WHERE user_id = ?").bind(userId).all()
        ]);
        userProviderRows = providers.results || [];
        keySet = new Set((keys.results || []).map(k => k.provider));
      } catch (err) {
        console.error("list query failed:", err.message);
      }
      const userModels = await getUserModels(userId, ctx.env);

      const keyLabel = (name) => keySet.has(name) ? "🔑 کلید شما"
        : getEnvKeyForProvider(name, ctx.env) ? "🔑 کلید مشترک ربات" : "⚠️ بدون کلید";
      const userModelLines = (provider) => userModels
        .filter(m => m.provider === provider)
        .map(m => {
          const shown = stripModelPrefix(provider, m.name);
          return `   ➕ ${m.id}${shown !== m.id ? ` — «${shown}»` : ""}`;
        });

      const blocks = [];
      for (const name of Object.keys(config.providers)) {
        blocks.push([
          `🔌 ${name} (پیش‌فرض) — ${keyLabel(name)}`,
          ...config.models.filter(m => m.provider === name).map(m => `   • ${m.id}`),
          ...userModelLines(name)
        ].join("\n"));
      }
      for (const p of userProviderRows) {
        blocks.push([
          `🔌 ${p.name} (اختصاصی) — ${keyLabel(p.name)}`,
          `   🌐 ${p.chat_endpoint}`,
          ...userModelLines(p.name)
        ].join("\n"));
      }

      let out = "📋 پروایدرها و مدل‌های هر پروایدر:\n\n" + blocks.join("\n\n") + "\n\n➕ = مدلی که خودتان اضافه کرده‌اید";
      if (!userProviderRows.length && !userModels.length) out += "\n\n" + MANAGE_HELP;
      return replyLong(ctx, out);
    } catch (err) {
      console.error("list error:", err);
      return ctx.reply(`❌ خطا: ${err.message || "خطای ناشناخته"}`);
    }
  });

  botCommand("clear", async (ctx) => {
    await ctx.env.DB.prepare("UPDATE user_memory SET recent_messages = NULL, summary = NULL WHERE user_id = ?")
      .bind(ctx.from.id).run();
    await ctx.reply("🧹 حافظه‌ی گفتگو پاک شد.");
  });

  botCommand("reset", async (ctx) => {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("DELETE FROM user_keys WHERE user_id = ?").bind(ctx.from.id),
      ctx.env.DB.prepare("UPDATE user_memory SET custom_endpoint = NULL WHERE user_id = ?").bind(ctx.from.id)
    ]);
    await ctx.reply("🔄 کلیدها و اندپوینت اختصاصی شما ریست شد.");
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});

    try {
      if (data.startsWith("setmod_")) {
        const idx = Number(data.slice("setmod_".length));
        const modelInfo = Number.isInteger(idx) ? config.models[idx] : null;

        if (!modelInfo) {
          return ctx.reply("❌ مدل مورد نظر یافت نشد.");
        }

        const modelKey = getModelKey(modelInfo);
        await ctx.env.DB.prepare(
          `INSERT INTO user_memory (user_id, selected_model) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET selected_model = excluded.selected_model`
        ).bind(ctx.from.id, modelKey).run();

        const refreshedKeyboard = await getModelsKeyboard(ctx.from.id, ctx.env);
        await ctx.editMessageReplyMarkup({ reply_markup: refreshedKeyboard }).catch(() => {});

        const st = keyStatusText(await getKeyStatus(ctx.from.id, modelInfo.provider, ctx.env), modelInfo.provider, true);
        return ctx.reply(
          `✅ مدل فعال تغییر کرد به:\n\`${modelInfo.name}\`\n🔌 پروایدر: \`${modelInfo.provider}\`` + (st ? `\n${st}` : "")
        );
      }

      if (data.startsWith("setumod_")) {
        const rowId = Number(data.slice("setumod_".length));
        const row = Number.isInteger(rowId)
          ? await ctx.env.DB.prepare("SELECT provider, model_id, name FROM user_models WHERE id = ? AND user_id = ?")
              .bind(rowId, ctx.from.id).first()
          : null;

        if (!row) {
          return ctx.reply("❌ مدل مورد نظر یافت نشد (شاید حذف شده باشد). دوباره /models را بزنید.");
        }

        const modelKey = getModelKey({ provider: row.provider, id: row.model_id });
        await ctx.env.DB.prepare(
          `INSERT INTO user_memory (user_id, selected_model) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET selected_model = excluded.selected_model`
        ).bind(ctx.from.id, modelKey).run();

        const refreshedKeyboard = await getModelsKeyboard(ctx.from.id, ctx.env);
        await ctx.editMessageReplyMarkup({ reply_markup: refreshedKeyboard }).catch(() => {});

        const st = keyStatusText(await getKeyStatus(ctx.from.id, row.provider, ctx.env), row.provider, true);
        return ctx.reply(
          `✅ مدل فعال تغییر کرد به:\n\`${modelLabel(row.provider, row.name)}\`\n🔌 پروایدر: \`${row.provider}\`` + (st ? `\n${st}` : "")
        );
      }
    } catch (err) {
      console.error("callback_query error:", err);
      await ctx.reply(`❌ خطا: ${err.message || "خطای ناشناخته"}`).catch(() => {});
    }
  });

bot.on(["message:text", "message:photo", "message:document", "message:voice", "message:audio"], async (ctx) => {
    const userId = ctx.from.id;
    let text = ctx.message.text?.trim() || "";
    let historyNote = null; // آنچه به‌جای محتوای کامل (که ممکن است حجیم باشد) در تاریخچه ذخیره می‌شود

    // دستورهای / (مثل /start و /models)
    if (ctx.message.text && text.startsWith("/")) {
      const cmdName = text.slice(1).split(/\s+/)[0].split("@")[0].toLowerCase();
      if (Object.hasOwn(commands, cmdName)) {
        try {
          await commands[cmdName](ctx);
        } catch (err) {
          console.error("command error:", err);
          await ctx.reply(`❌ خطا: ${err.message || "خطای ناشناخته"}`).catch(() => {});
        }
        return;
      }
    }

    try {
      // پیام صوتی یا فایل صوتی → تبدیل به متن با Whisper (Groq)، سپس مثل یک پیام متنی عادی ادامه پیدا می‌کند
  if (ctx.message.voice || ctx.message.audio) {
  await ctx.replyWithChatAction("typing").catch(() => {});
  try {
    const media = ctx.message.voice || ctx.message.audio;
    const { buffer } = await downloadBaleFile(media.file_id, ctx); // filename را حذف کردیم
    
    const transcript = (await transcribeAudio(
      userId, 
      buffer, 
      media.mime_type, 
      null, // <-- null
      ctx.env
    )).trim();
    
    if (!transcript) {
      return ctx.reply("❌ چیزی از این پیام صوتی تشخیص داده نشد.");
    }
    
    await ctx.reply(`🎙 متن پیاده‌شده:\n${transcript}`);
    text = transcript;
    historyNote = `🎙 پیام صوتی: ${transcript.slice(0, 200)}`;
    
  } catch (err) {
    console.error("❌ transcribe error:", err);
    return ctx.reply(`❌ تبدیل صوت به متن با خطا مواجه شد:\n${err.message || "خطای ناشناخته"}`);
  }
}



      // فایل/سند → استخراج متن (PDF یا فایل متنی) و تحلیل با AI
      if (ctx.message.document) {
        await ctx.replyWithChatAction("typing").catch(() => {});
        try {
          const doc = ctx.message.document;
          const { buffer, filename, ext } = await downloadBaleFile(doc.file_id, ctx);
          const extracted = await extractDocumentText(buffer, doc.mime_type, filename, ext);
          const instruction = ctx.message.caption?.trim() || "این فایل را تحلیل و خلاصه کن.";
          text = `${instruction}\n\n--- محتوای فایل «${filename}» ---\n${extracted}`;
          historyNote = `📄 فایل: ${filename}`;
        } catch (err) {
          console.error("document extract error:", err);
          return ctx.reply(`❌ خواندن فایل با خطا مواجه شد:\n${err.message || "خطای ناشناخته"}`);
        }
      }

      // تولید تصویر: "عکس <prompt>"
      if (text.startsWith("عکس ")) {
        const prompt = text.slice("عکس ".length).trim();
        if (!prompt) {
          return ctx.reply("❌ بعد از «عکس» توضیح تصویر مورد نظر را بنویسید.\nمثال: `عکس یک ماشین اسپرت در شب`");
        }
        await ctx.replyWithChatAction("upload_photo").catch(() => {});
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${Math.floor(Math.random() * 1000000)}`;
        try {
          const imgRes = await fetchWithTimeout(imageUrl, {}, 60000);
          if (!imgRes.ok) throw new Error(`image service status ${imgRes.status}`);
          const imgBuffer = new Uint8Array(await imgRes.arrayBuffer());
          return await ctx.replyWithPhoto(new InputFile(imgBuffer, "image.jpg"), { caption: `🎨 تصویر: ${prompt}` });
        } catch (err) {
          console.error("image generation error:", err);
          return ctx.reply("❌ ساخت تصویر با خطا مواجه شد. لطفاً دوباره تلاش کنید.");
        }
      }

      // جستجوی وب: "جستجو <عبارت>"
      if (text.startsWith("جستجو ")) {
        const query = text.slice("جستجو ".length).trim();
        if (!query) {
          return ctx.reply("❌ بعد از «جستجو» عبارت مورد نظر را بنویسید.\nمثال: `جستجو آخرین اخبار هوش مصنوعی`");
        }
        await ctx.replyWithChatAction("typing").catch(() => {});
        try {
          const { answer, sources } = await searchWeb(userId, query, ctx.env);
          let replyText = answer;
          if (sources.length) {
            replyText += "\n\n📎 منابع:\n" + sources.map((s, i) => `${i + 1}. ${s.title ? s.title + " — " : ""}${s.uri}`).join("\n");
          }
          return replySmart(ctx, replyText);
        } catch (err) {
          console.error("web search error:", err);
          return ctx.reply(`❌ جستجو با خطا مواجه شد:\n${err.message || "خطای ناشناخته"}`);
        }
      }

      // مدیریت پروایدر/مدل اختصاصی (فقط برای پیام‌های متنی واقعی، نه متنِ استخراج‌شده از فایل/ویس)
      if (ctx.message.text && await handleProviderModelCommand(ctx, text)) return;

      // ثبت کلید پروایدر یا سرویس جستجو: "provider api_key" / "tavily api_key"
      const firstWord = text.split(" ")[0]?.toLowerCase();
      if (firstWord && (Object.hasOwn(config.providers, firstWord) || firstWord === "tavily")) {
        const apiKey = text.split(" ").slice(1).join(" ").trim();
        if (!apiKey) {
          return ctx.reply("❌ لطفاً کلید API را بعد از نام پروایدر وارد کنید. مثال:\n`openai sk-...`");
        }
        const provider = firstWord;
        const encryptedKey = await encryptText(apiKey, ctx.env.ENCRYPTION_KEY);

        await ctx.env.DB.prepare(
          `INSERT INTO user_keys (user_id, provider, api_key) VALUES (?, ?, ?)
           ON CONFLICT(user_id, provider) DO UPDATE SET api_key = excluded.api_key`
        ).bind(userId, provider, encryptedKey).run();

        await ctx.reply(`🔑 *کلید پروایدر ${provider} با موفقیت ذخیره شد.*`);
        await ctx.deleteMessage().catch(() => {});
        return;
      }

      // ثبت اندپوینت اختصاصی: "endpoint https://..."
      if (text.toLowerCase().startsWith("endpoint ")) {
        const endpoint = text.slice("endpoint ".length).trim();
        try {
          const parsed = new URL(endpoint);
          if (parsed.protocol !== "https:") throw new Error();
        } catch {
          return ctx.reply("❌ آدرس اندپوینت نامعتبر است. باید با https شروع شود.");
        }

        await ctx.env.DB.prepare(
          `INSERT INTO user_memory (user_id, custom_endpoint) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET custom_endpoint = excluded.custom_endpoint`
        ).bind(userId, endpoint).run();

        return ctx.reply("🌐 اندپوینت اختصاصی شما ذخیره شد.");
      }

      // --- چت عادی ---
      const row = await ctx.env.DB.prepare("SELECT * FROM user_memory WHERE user_id = ?").bind(userId).first();
      const selectedModel = row?.selected_model || getModelKey(config.models[0]);

      let summary = "";
      if (row?.summary) {
        const decryptedSummary = await decryptText(row.summary, ctx.env.ENCRYPTION_KEY);
        summary = decryptedSummary || "";
      }

      let recentMessages = [];
      if (row?.recent_messages) {
        const decrypted = await decryptText(row.recent_messages, ctx.env.ENCRYPTION_KEY);
        if (decrypted) {
          try {
            const parsed = JSON.parse(decrypted);
            if (Array.isArray(parsed)) recentMessages = parsed;
          } catch {
            recentMessages = [];
          }
        } else {
          // رمزگشایی ناموفق بود (مثلاً ENCRYPTION_KEY عوض شده) → تاریخچه‌ی خراب را پاک می‌کنیم
          await ctx.env.DB.prepare("UPDATE user_memory SET recent_messages = NULL WHERE user_id = ?").bind(userId).run();
        }
      }

      let userContent = text;
      if (ctx.message.photo) {
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1]; // بدون mutate کردن آرایه‌ی اصلی
        // امنیت: هرگز لینک حاوی BOT_TOKEN را مستقیم به یک پروایدر شخص‌ثالث نفرستید؛
        // عکس را خودمان دانلود و base64 می‌کنیم.
        const { buffer, ext } = await downloadBaleFile(photo.file_id, ctx);
        const base64 = arrayBufferToBase64(buffer);
        const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        userContent = [
          { type: "text", text: ctx.message.caption || "این تصویر را تحلیل کن." },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
        ];
      }

      if (!text && !ctx.message.photo) return;

      recentMessages.push({ role: "user", content: userContent });

      if (recentMessages.length > HISTORY_LIMIT) {
        const overflow = recentMessages.slice(0, recentMessages.length - HISTORY_LIMIT);
        summary = await summarizeHistory(userId, summary, overflow, ctx.env);
      }
      const trimmedHistory = recentMessages.slice(-HISTORY_LIMIT);

      const systemPrompt = summary
        ? `شما یک دستیار هوشمند و مفید هستید که به فارسی پاسخ می‌دهید.\nخلاصه‌ی گفتگوی قبلی:\n${summary}`
        : "شما یک دستیار هوشمند و مفید هستید که به فارسی پاسخ می‌دهید.";

      const messagesToSend = [
        { role: "system", content: systemPrompt },
        ...trimmedHistory
      ];

      await ctx.replyWithChatAction("typing").catch(() => {});

      let aiReply;
      try {
        aiReply = await callAIProvider(userId, selectedModel, messagesToSend, ctx.env, row?.custom_endpoint);
      } catch (err) {
        console.error("callAIProvider error:", err);
        return ctx.reply(`❌ خطا در دریافت پاسخ:\n${err.message || "خطای ناشناخته"}`);
      }

      recentMessages[recentMessages.length - 1].content = historyNote || (ctx.message.photo ? (ctx.message.caption || "ارسال تصویر") : text);
      recentMessages.push({ role: "assistant", content: aiReply });
      const finalHistory = recentMessages.slice(-HISTORY_LIMIT);
      const encryptedMessages = await encryptText(JSON.stringify(finalHistory), ctx.env.ENCRYPTION_KEY);
      const encryptedSummary = await encryptText(summary, ctx.env.ENCRYPTION_KEY);

      await ctx.env.DB.prepare(
        `INSERT INTO user_memory (user_id, selected_model, recent_messages, summary) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET recent_messages = excluded.recent_messages, summary = excluded.summary`
      ).bind(userId, selectedModel, encryptedMessages, encryptedSummary).run();

      await replySmart(ctx, aiReply);
    } catch (err) {
      console.error("message handler error:", err);
      await ctx.reply(`❌ خطای غیرمنتظره: ${err.message || "خطای ناشناخته"}`).catch(() => {});
    }
  });
}

// ==========================================
// ۸. اجرای Worker روی Cloudflare (کش کردن botInfo بین درخواست‌ها)
// ==========================================
let cachedBotInfo = null;

async function getBot(env) {
  const bot = new Bot(env.BOT_TOKEN, {
    client: { apiRoot: BALE_API_ROOT },
    ...(cachedBotInfo ? { botInfo: cachedBotInfo } : {})
  });
  bot.use(async (ctx, next) => {
    ctx.env = env;
    await next();
  });
  registerHandlers(bot);
  if (!cachedBotInfo) {
    await bot.init();
    cachedBotInfo = bot.botInfo;
    await bot.api.setMyCommands([
      { command: "start", description: "🏠 منوی اصلی" },
      { command: "models", description: "🤖 تغییر مدل هوش مصنوعی" },
      { command: "list", description: "📋 پروایدرها و مدل‌های من" },
      { command: "clear", description: "🧹 پاکسازی حافظه" },
      { command: "reset", description: "🔄 ریست تنظیمات" }
    ]).catch(err => console.error("setMyCommands failed:", err));
  }
  return bot;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = env.WEBHOOK_SECRET;

    if (request.method === "GET") {
      // ابزار کمکی برای وصل کردن وبهوک بدون ترمینال:
      //   https://<worker>/setwebhook?key=WEBHOOK_SECRET   ← ثبت وبهوک
      //   https://<worker>/webhookinfo?key=WEBHOOK_SECRET  ← بررسی وضعیت
      if (url.pathname === "/setwebhook" || url.pathname === "/webhookinfo") {
        if (!secret || url.searchParams.get("key") !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }
        const isSet = url.pathname === "/setwebhook";
        try {
          const r = await fetch(`${BALE_API_ROOT}/bot${env.BOT_TOKEN}/${isSet ? "setWebhook" : "getWebhookInfo"}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(isSet ? { url: `${url.origin}/${secret}` } : {})
          });
          return new Response(await r.text(), { headers: { "Content-Type": "application/json; charset=utf-8" } });
        } catch (err) {
          return new Response(`خطا در ارتباط با بله: ${err.message}`, { status: 502 });
        }
      }
      return new Response("OK");
    }

    if (request.method !== "POST") {
      return new Response("OK");
    }

    // امنیت: بله هدر secret_token ندارد؛ پس آدرس وبهوک خودش حاوی WEBHOOK_SECRET است (https://<worker>/<WEBHOOK_SECRET>)
    if (secret) {
      const okPath = url.pathname === `/${secret}`;
      const okHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
      if (!okPath && !okHeader) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const bot = await getBot(env);

    // پاسخ سریع به بله تا از ارسال مجدد آپدیت به‌خاطر تایم‌اوت جلوگیری شود؛
    // پردازش واقعی (که ممکن است چند ثانیه طول بکشد) در پس‌زمینه با waitUntil انجام می‌شود.
    ctx.waitUntil(
      bot.handleUpdate(update).catch(err => console.error("handleUpdate error:", err))
    );

    return new Response("OK");
  }
};
