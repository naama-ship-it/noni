# נוני — העוזרת האישית (גרסה 2026-11-02-01)

עוזרת אישית לכל אחד: אתר + ווטסאפ, הרשמה עצמית עם חשבון Google, חינם בפיילוט.
נגזרת מקוד Timeline Assist, בלי שום קשר לבית ספר. אותה תשתית Google Cloud (Cloud Run + Cloud SQL
ב-me-west1), שירות ומסד נפרדים.

## מה יש
* **כניסה** — Google Identity Services באתר; השרת מאמת את אסימון הזהות (`google-auth-library`) ופותח סשן
  בעוגייה חתומה (30 יום). הרשמה עצמית: כל מי שנכנס/ת — נרשם/ת. `PLATFORM_ADMINS` = מנהלת הפלטפורמה.
* **שכבת המומחית** — כללי הפלטפורמה (הגדרות ← כללי הפלטפורמה) + העדפות אישיות = הנחיית המערכת.
* **כלים** — משימות, תזכורות, יומן גוגל (OAuth, `calendar.readonly`), מייל (כשיופעל `GOOGLE_SCOPES=calendar,gmail`).
* **ווטסאפ** — WhatsApp Cloud API של Meta. קישור: הגדרות ← ווטסאפ ← טלפון ← קוד ← שולחים "קוד 123456"
  למספר של נוני. אחר כך כל הודעה = שיחה (שיחה אחת מתמשכת בשם "ווטסאפ"). תזכורות יוצאות דרך
  `POST /api/cron/reminders` (Cloud Scheduler כל דקה, כותרת `X-Cron-Key`); מחוץ לחלון 24 השעות נדרשת
  תבנית מאושרת (`WA_TEMPLATE_REMINDER`, פרמטר אחד).
* **הבית (2026-11-02)** — משק בית משותף (`noni_household`, קוד הזמנה בן 6 תווים; בן/בת זוג מצטרפ/ת מהלשונית
  "הבית"); רשימות משותפות (קניות + רשימות חופשיות, `noni_list`/`noni_list_item`, בלי כפילויות); תורנויות בסבב
  (`noni_chore`: daily/weekly/once, "בוצע" מעביר את התור); הוצאות (`noni_expense`, קטגוריות קבועות + מיפוי
  מתיאור חופשי, סיכום שבוע/חודש/חודש קודם, משותף לבני הבית). כלים למודל: `list_items`, `add_list_items`,
  `check_list_items`, `clear_done_items`, `list_chores`, `add_chore`, `chore_done`, `household_info`,
  `add_expense`, `list_expenses`, `expense_summary`, `plan_day`.
* **תכנון היום** — `POST /api/plan` (עם `note` לתכנון מחדש): המודל מקבל יומן+משימות+תזכורות+תורנויות
  (`plan_day`) ומחזיר לוח זמנים; נשמר ב-`ast_user_pref` תחת `plan:<תאריך>`.
* **תדריך** — כולל עכשיו מיילים שלא נקראו (דורש `gmail` ב-`GOOGLE_SCOPES` ואישור מחדש של החיבור — הכפתור
  "הוספת מייל" בהגדרות), תורנויות להיום, סיכום הוצאות ומספר הפריטים בקניות.
* **ווטסאפ רב-אופני** — הודעה קולית ← תמלול; תמונה/מסמך (קבלה, פתק, הזמנה) ← תיאור ממוקד; הודעה
  שהועברה מסומנת. המדיה נמשכת מ-Meta ונשלחת ל-Gemini (`geminiMedia`) באותו פרויקט; הקובץ לא נשמר.
* **דמו** — `bash build-demo.sh` בונה את `demo/index.html` וגם `public/demo/index.html`; ה-Worker
  `nonidemotimeline-schoolcom` (noni-demo.timeline-school.com) מושך את הדמו מ-`/demo/index.html` של השירות,
  כך שכל פריסה מעדכנת גם את הדמו.
* **המודל** — `LLM_PROVIDER`: gemini (ברירת מחדל בפיילוט) · vertex (Claude) · anthropic · mock.

## פריסה (Cloud Shell, naama@timeline-school.com)
```
bash deploy-noni.sh db && bash deploy-noni.sh sa && bash deploy-noni.sh secrets
bash deploy-noni.sh build && bash deploy-noni.sh deploy
bash deploy-noni.sh cron
```
לפני `secrets`: בקונסול ← APIs & Services ← Credentials ← OAuth client (Web). Authorized JavaScript
origins = כתובת האתר; Redirect URI = `<כתובת>/api/connect/google/callback`. אותו לקוח משמש גם לכניסה
וגם ליומן. מסך ההסכמה: שם "נוני", הרשאת `calendar.readonly`.

ווטסאפ: אפליקציית Meta ← WhatsApp ← מספר ← Permanent token; Webhook URL = `<כתובת>/api/wa/webhook`,
Verify token = הערך שהסקריפט מדפיס; להירשם לאירוע `messages`. `WA_PHONE_ID` ו-`WA_DISPLAY_NUMBER` מועברים
לפריסה כמשתני סביבה.

## הרצה מקומית
```
AUTH_MODE=none LLM_PROVIDER=mock DB_HOST=127.0.0.1 DB_PORT=5433 DB_NAME=noni PORT=8091 node server.js
BASE=http://localhost:8091 node test/smoke.js
```
`public/index.html?demo=1` — דמו עצמאי בלי שרת.

© כל הזכויות שמורות לנעמה אורפלי
