-- ============================================================
-- Timeline Assist — סכמת הנתונים (PostgreSQL 16, Cloud SQL me-west1)
-- ------------------------------------------------------------
-- מודול חדש של Timeline: עוזר/ת AI אישי/ת לכל מורה, במנוי לבית הספר.
-- המבנה רב-דיירים מהיום הראשון: כל שורה שייכת לבית ספר (tenant),
-- וכל מה שאישי שייך גם למשתמש/ת (user). שלוש שכבות של "כללים":
--   platform_rules  — הכללים והיכולות שנעמה (המומחית) מפרסמת לכולם
--   tenant_rules    — התאמות של בית הספר (אחראי/ת המערכת שלו)
--   user_prefs      — העדפות אישיות של המורה
-- הסכמה אידמפוטנטית: אפשר להריץ שוב ושוב בלי נזק.
--
-- © כל הזכויות שמורות לנעמה אורפלי
-- ============================================================

CREATE TABLE IF NOT EXISTS ast_tenant (
  id            TEXT PRIMARY KEY,                 -- beresheet / hayovel / demo
  name          TEXT NOT NULL,                    -- שם בית הספר לתצוגה
  plan          TEXT NOT NULL DEFAULT 'trial',    -- trial / basic / full
  seats         INTEGER NOT NULL DEFAULT 60,      -- מספר מורים מורשים
  timeline_agent_url TEXT NOT NULL DEFAULT '',    -- כתובת סוכן הצוות של בית הספר (api/ask)
  timezone      TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ast_user (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES ast_tenant(id),
  email         TEXT NOT NULL,                    -- הזהות מהשער (IAP) — באותיות קטנות
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'teacher',  -- teacher / school_admin / platform_admin
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS ast_user_email ON ast_user (email);

-- כללים ויכולות של הפלטפורמה (שכבת "המומחית"). kind: rule / skill / automation
CREATE TABLE IF NOT EXISTS ast_platform_rule (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'rule',
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,                    -- הנוסח שנכנס להנחיית המערכת
  sort_order    INTEGER NOT NULL DEFAULT 100,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by    TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- התאמות של בית הספר
CREATE TABLE IF NOT EXISTS ast_tenant_rule (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES ast_tenant(id),
  kind          TEXT NOT NULL DEFAULT 'rule',
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by    TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ast_tenant_rule_t ON ast_tenant_rule (tenant_id);

-- העדפות אישיות (מפתח/ערך) — למשל שעת תדריך הבוקר, כינוי, סגנון
CREATE TABLE IF NOT EXISTS ast_user_pref (
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- משימות של המורה
CREATE TABLE IF NOT EXISTS ast_task (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES ast_tenant(id),
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  notes         TEXT NOT NULL DEFAULT '',
  due_date      DATE,                              -- יום יעד (ללא שעה)
  due_time      TIME,                              -- שעה, אם יש
  priority      SMALLINT NOT NULL DEFAULT 2,       -- 1 גבוה · 2 רגיל · 3 נמוך
  status        TEXT NOT NULL DEFAULT 'open',      -- open / done / dropped
  source        TEXT NOT NULL DEFAULT 'chat',      -- chat / ui / brief
  done_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ast_task_user ON ast_task (user_id, status, due_date);

-- תזכורות — "תזכירי לי ב-..." ; נשלחות כרגע בתוך האפליקציה (ובהמשך גם SMS/מייל)
CREATE TABLE IF NOT EXISTS ast_reminder (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES ast_tenant(id),
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  remind_at     TIMESTAMPTZ NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'app',      -- app / wa
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending / shown / sent / cancelled
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ast_reminder ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ast_reminder_due ON ast_reminder (user_id, status, remind_at);

-- שיחות והודעות — נשמרות לזמן מוגבל (RETENTION_DAYS בשרת), כדי להמשיך שיחה בין מכשירים
CREATE TABLE IF NOT EXISTS ast_conversation (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES ast_tenant(id),
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ast_conv_user ON ast_conversation (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ast_message (
  id            BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES ast_conversation(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,                    -- user / assistant
  content       TEXT NOT NULL,
  tools_used    TEXT NOT NULL DEFAULT '',         -- שמות הכלים שהופעלו, מופרדים בפסיק (לשקיפות)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ast_msg_conv ON ast_message (conversation_id, id);

-- יומן פעולות (לדרישת יומן גישה בתקן) — מי, מה, מתי; בלי תוכן השיחה
CREATE TABLE IF NOT EXISTS ast_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT '',
  who           TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL,
  ref           TEXT NOT NULL DEFAULT '',
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ast_log_at ON ast_log (at DESC);

-- שימוש יומי (מגבלת שאלות למורה ליום, כמו בסוכן הצוות)
CREATE TABLE IF NOT EXISTS ast_usage (
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  questions     INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ---- נתוני פתיחה: בית ספר ראשון + כללי הפלטפורמה הבסיסיים ----
INSERT INTO ast_tenant (id, name, plan, seats, timeline_agent_url)
VALUES ('noni', 'נוני', 'pilot', 100000, '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ast_platform_rule (kind, title, body, sort_order)
SELECT * FROM (VALUES
  ('rule', 'שפה וסגנון', 'עני/ה בעברית בלבד, בקצרה ובבהירות. פני/ה בלשון זכר ונקבה כאחד ("בחר/י") או בלשון נייטרלית. מונחים באנגלית — אחרי ההסבר בעברית, בסוגריים.', 10),
  ('rule', 'אמינות', 'אל תמציא/י נתונים. כשמידע מגיע מכלי — הצג/י אותו כפי שהוא. כשאין נתון — אמור/י זאת והצע/י מה אפשר לבדוק.', 20),
  ('rule', 'פרטיות', 'הצג/י רק מידע של המשתמש/ת עצמו/ה או מידע שהכלים החזירו. אל תנחש/י מידע על אנשים אחרים ואל תשתף/י פרטי קשר של אחרים.', 30),
  ('rule', 'פעולה לפני שאלה', 'כשהבקשה ברורה — בצע/י (הוסף/י משימה, קבע/י תזכורת) ואשר/י במשפט אחד. שאל/י שאלת הבהרה רק כשבאמת חסר פרט מכריע.', 40),
  ('skill', 'תדריך בוקר', 'כשמבקשים "מה היום" או תדריך: היומן של היום (אם מחובר), משימות שמועדן היום או שעבר, ותזכורות קרובות — בסדר הזה, קצר, עם הצעה אחת לסדר עדיפויות.', 50),
  ('rule', 'ווטסאפ', 'בווטסאפ: משפט עד שלושה, בלי עיצוב (בלי כוכביות או כותרות), בלי רשימות ארוכות. אם צריך פירוט — הצע/י לפתוח באתר.', 60)
) AS v(kind, title, body, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM ast_platform_rule);

-- ---- שלב 2: חיבורים אישיים של המורה (גוגל: יומן ומייל) ----
-- אסימון הרענון נשמר מוצפן (AES-256-GCM, מפתח CONN_KEY ב-Secret Manager) ושייך למורה בלבד.
CREATE TABLE IF NOT EXISTS ast_connection (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES ast_tenant(id),
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,                    -- google (בהמשך: microsoft)
  account_email TEXT NOT NULL DEFAULT '',         -- החשבון שחובר
  scopes        TEXT NOT NULL DEFAULT '',
  refresh_enc   TEXT NOT NULL,                    -- אסימון רענון מוצפן
  access_token  TEXT NOT NULL DEFAULT '',         -- אסימון גישה קצר-חיים (לא סודי לטווח ארוך)
  expires_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active',   -- active / revoked / error
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- מצבי OAuth חד-פעמיים (state) — נמחקים אחרי שימוש או אחרי 15 דקות
CREATE TABLE IF NOT EXISTS ast_oauth_state (
  state         TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- נוני: קישור ווטסאפ (מספר אחד לכל משתמש/ת) ----
CREATE TABLE IF NOT EXISTS noni_wa (
  user_id       BIGINT PRIMARY KEY REFERENCES ast_user(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL UNIQUE,            -- ספרות בלבד, עם קידומת מדינה (972…)
  code          TEXT,                            -- קוד קישור חד-פעמי; NULL אחרי אימות
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- נוני — משק בית, רשימות משותפות, תורנויות והוצאות (2026-11-02)
-- משק בית = קבוצה של משתמשים (בני זוג, שותפים, משפחה) שחולקים רשימות ותורנויות.
-- כל משתמש/ת שייך/ת לכל היותר למשק בית אחד; הצטרפות בקוד הזמנה.
-- ============================================================
CREATE TABLE IF NOT EXISTS noni_household (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT 'הבית שלי',
  invite_code   TEXT NOT NULL UNIQUE,            -- קוד הצטרפות קצר (6 תווים)
  created_by    BIGINT REFERENCES ast_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ast_user ADD COLUMN IF NOT EXISTS household_id BIGINT REFERENCES noni_household(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ast_user_household ON ast_user (household_id);

-- רשימות משותפות (קניות וכל רשימה חופשית) — שייכות למשק הבית
CREATE TABLE IF NOT EXISTS noni_list (
  id            BIGSERIAL PRIMARY KEY,
  household_id  BIGINT NOT NULL REFERENCES noni_household(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                   -- "קניות", "לטיול", "לסופר"
  kind          TEXT NOT NULL DEFAULT 'list',    -- shopping / list
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, name)
);
CREATE TABLE IF NOT EXISTS noni_list_item (
  id            BIGSERIAL PRIMARY KEY,
  list_id       BIGINT NOT NULL REFERENCES noni_list(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  qty           TEXT NOT NULL DEFAULT '',        -- "2", "ק"ג" — טקסט חופשי
  done          BOOLEAN NOT NULL DEFAULT FALSE,
  added_by      TEXT NOT NULL DEFAULT '',        -- שם לתצוגה של מי שהוסיף/ה
  done_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS noni_list_item_l ON noni_list_item (list_id, done, id);

-- תורנויות — מטלה שמתחלפת בין בני הבית לפי סבב
CREATE TABLE IF NOT EXISTS noni_chore (
  id            BIGSERIAL PRIMARY KEY,
  household_id  BIGINT NOT NULL REFERENCES noni_household(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,                   -- "להוציא את הזבל", "איסוף מהגן"
  people        TEXT[] NOT NULL DEFAULT '{}',    -- סבב השמות
  turn_idx      INTEGER NOT NULL DEFAULT 0,      -- של מי התור עכשיו (אינדקס ב-people)
  cadence       TEXT NOT NULL DEFAULT 'weekly',  -- daily / weekly / once
  next_date     DATE,
  last_done_by  TEXT NOT NULL DEFAULT '',
  last_done_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS noni_chore_h ON noni_chore (household_id, next_date);

-- הוצאות — אישיות (ונראות גם לבני הבית כשיש משק בית)
CREATE TABLE IF NOT EXISTS noni_expense (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES ast_user(id) ON DELETE CASCADE,
  household_id  BIGINT REFERENCES noni_household(id) ON DELETE SET NULL,
  amount        NUMERIC(12,2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'ILS',
  category      TEXT NOT NULL DEFAULT 'אחר',     -- מזון / בית / ילדים / רכב / בריאות / פנאי / ביגוד / אחר
  note          TEXT NOT NULL DEFAULT '',        -- "סופר", "דלק"
  spent_on      DATE NOT NULL DEFAULT current_date,
  source        TEXT NOT NULL DEFAULT 'chat',    -- chat / ui / wa / receipt
  added_by      TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS noni_expense_u ON noni_expense (user_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS noni_expense_h ON noni_expense (household_id, spent_on DESC);

-- שיתוף רשימה בקישור (2026-11-02): אסימון אקראי לכל רשימה; מי שיש לו את הקישור רואה את הרשימה
-- ומסמן/מוחק פריטים בלי כניסה. ביטול השיתוף = NULL.
ALTER TABLE noni_list ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;


-- ---- נוני: SMS (Twilio) — מספר לתזכורות, מאומת בקוד חד-פעמי ----
CREATE TABLE IF NOT EXISTS noni_sms (
  user_id       BIGINT PRIMARY KEY REFERENCES ast_user(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,                   -- ספרות בלבד, עם קידומת מדינה (972…)
  code          TEXT,                            -- קוד אימות; NULL אחרי אימות
  code_at       TIMESTAMPTZ,
  attempts      INT NOT NULL DEFAULT 0,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
