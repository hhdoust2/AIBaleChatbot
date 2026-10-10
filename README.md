# ربات بله (Bale) برای چت با مدل‌های هوش مصنوعی از طریق کلید و اندپوینت — اجرا روی ورکر کلادفلر

👋 به ربات هوش مصنوعی خوش آمدید!

مستقیماً پیام بدهید تا با مدل فعال چت شود. برای مدیریت از دستورات زیر (منوی Menu پایین چت) استفاده کنید:

🤖 /models — تغییر مدل هوش مصنوعی
🧹 /clear — پاکسازی حافظه‌ی گفتگو
🔄 /reset — ریست کلیدها و اندپوینت

🎨 ساخت تصویر: پیام را با «عکس» شروع کنید:
عکس یک ماشین اسپرت در شب

🔎 جستجوی وب: پیام را با «جستجو» شروع کنید (نیاز به کلید Tavily؛ رایگان از tavily.com):
جستجو آخرین اخبار هوش مصنوعی

🖼 تحلیل عکس: فقط عکس بفرستید (با توضیح دلخواه در کپشن).
📄 تحلیل فایل: فایل PDF یا متنی (txt, md, csv, json, ...) بفرستید تا خلاصه/تحلیل شود.
🎙 تبدیل صوت به متن: ویس یا فایل صوتی بفرستید (نیاز به کلید Groq).

📌 برای ثبت کلید اختصاصی یک پروایدر یا Tavily:
provider api_key یا tavily api_key
پروایدرهای پشتیبانی‌شده:
google your_api_key
openrouter your_api_key
anymodel your_api_key
groq your_api_key
tomdacat your_api_key

📌 برای ثبت اندپوینت اختصاصی:
endpoint https://your-endpoint.com/v1/chat/completions

➕ افزودن پروایدر و مدل دلخواه (مخصوص خودتان، بدون نیاز به تغییر کد):
(provider = نام پروایدر؛ مثلاً groq یا نامی که خودتان می‌سازید)
addprovider provider https://api.example.com/v1/chat/completions your_api_key
(کلید اختیاری است؛ پروایدر باید API سازگار با OpenAI داشته باشد و اندپوینت باید https باشد)
addmodel provider model-id [نام نمایشی]
addmodel groq llama-3.3-70b-versatile  ← مثال؛ افزودن مدل به پروایدرهای پیش‌فرض هم ممکن است
(نام مدل در /models همیشه با پیشوند پروایدر نوشته می‌شود، مثل Groq * llama-3.3-70b-versatile)
delprovider provider  ← حذف پروایدر به‌همراه مدل‌ها و کلیدش
delmodel provider model-id
provider your_api_key  ← ثبت/تغییر کلید آن پروایدر
📋 /list — نمایش همه‌ی پروایدرها، وضعیت کلید هر کدام و مدل‌های هر پروایدر (➕ = مدل اضافه‌شده توسط شما)

⚙️ نکته‌ی استقرار: بعد از به‌روزرسانی، یک بار اسکیمای جدید را روی D1 اجرا کنید:
wrangler d1 execute bot_db --remote --file=migrations.sql
