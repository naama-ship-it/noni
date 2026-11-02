#!/usr/bin/env bash
# ============================================================
# נוני — הקמה ופריסה בגוגל קלאוד (אותו פרויקט ותשתית כמו Timeline, שירות נפרד)
# ------------------------------------------------------------
# מניח: רשת timeline-vpc, מופע Cloud SQL timeline-sql-test, Artifact Registry
# בשם timeline, דלי הבנייה gs://timeline-school-test-build.
#
# שימוש (מ-Cloud Shell, בתיקיית הערכה):
#   bash deploy-noni.sh db        # מסד noni + משתמש + סוד
#   bash deploy-noni.sh sa        # חשבון שירות + הרשאות
#   bash deploy-noni.sh secrets   # סוד הסשן, מזהה/סוד OAuth של גוגל (מבקש בטרמינל), ווטסאפ, cron
#   bash deploy-noni.sh build && bash deploy-noni.sh deploy
#   bash deploy-noni.sh cron      # Cloud Scheduler: תזכורות בווטסאפ כל דקה
#   bash deploy-noni.sh provider gemini|vertex
#
# © כל הזכויות שמורות לנעמה אורפלי
# ============================================================
set -euo pipefail

PROJECT=${PROJECT:-timeline-school-test}
REGION=me-west1
SQL_INSTANCE=timeline-sql-test
DB_NAME=noni
DB_USER=noni
SERVICE=noni
REPO=timeline
NETWORK=timeline-vpc
SUBNET=timeline-subnet-${REGION}
SA=noni-sa
VERTEX_REGION=${VERTEX_REGION:-eu}
MODEL=${MODEL:-claude-sonnet-4-6}
LLM_PROVIDER=${LLM_PROVIDER:-gemini}
GEMINI_MODEL=${GEMINI_MODEL:-gemini-3.5-flash}
GEMINI_REGION=${GEMINI_REGION:-eu}
PLATFORM_ADMINS=${PLATFORM_ADMINS:-naama@timeline-school.com naama3101@gmail.com}
PUBLIC_URL=${PUBLIC_URL:-}          # כתובת האתר (אחרי הפריסה הראשונה — כתובת השירות; אחר כך הדומיין)

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
SA_EMAIL="$SA@$PROJECT.iam.gserviceaccount.com"
mksecret() {   # mksecret <שם> <ערך-מ-stdin>
  if gcloud secrets describe "$1" >/dev/null 2>&1; then gcloud secrets versions add "$1" --data-file=- >/dev/null; else gcloud secrets create "$1" --data-file=- --replication-policy=user-managed --locations="$REGION" >/dev/null; fi
  gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$SA_EMAIL" --role=roles/secretmanager.secretAccessor >/dev/null
}

s_db() {
  step "מסד $DB_NAME"
  gcloud config set project "$PROJECT"
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" || true
  if ! gcloud secrets describe noni-db-pass >/dev/null 2>&1; then
    PASS=$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)
    printf '%s' "$PASS" | gcloud secrets create noni-db-pass --data-file=- --replication-policy=user-managed --locations="$REGION"
    gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$PASS"
    unset PASS
  fi
}
s_sa() {
  step "חשבון שירות"
  gcloud iam service-accounts create "$SA" --display-name="Noni (Cloud Run)" || true
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_EMAIL" --role=roles/cloudsql.client --condition=None >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_EMAIL" --role=roles/aiplatform.user --condition=None >/dev/null
  gcloud secrets add-iam-policy-binding noni-db-pass --member="serviceAccount:$SA_EMAIL" --role=roles/secretmanager.secretAccessor >/dev/null
}
s_secrets() {
  step "סודות"
  # סוד הסשן ומפתח ה-cron — נוצרים לבד
  gcloud secrets describe noni-session-secret >/dev/null 2>&1 || openssl rand -base64 48 | tr -d '\n' | mksecret noni-session-secret
  gcloud secrets describe noni-cron-key >/dev/null 2>&1 || openssl rand -hex 24 | tr -d '\n' | mksecret noni-cron-key
  gcloud secrets describe noni-conn-key >/dev/null 2>&1 || openssl rand -base64 32 | tr -d '\n' | mksecret noni-conn-key
  # OAuth של גוגל (כניסה + יומן): לקוח Web אחד. נוצר בקונסול; כאן רק נשמר.
  if ! gcloud secrets describe noni-google-client-id >/dev/null 2>&1; then
    read -r -p "Google OAuth Client ID: " CID; printf '%s' "$CID" | mksecret noni-google-client-id
    read -r -s -p "Google OAuth Client Secret: " CSEC; echo; printf '%s' "$CSEC" | mksecret noni-google-client-secret; unset CSEC
  fi
  # ווטסאפ (Meta): אפשר לדלג עכשיו ולהריץ שוב אחרי פתיחת חשבון Meta
  if ! gcloud secrets describe noni-wa-token >/dev/null 2>&1; then
    read -r -p "WhatsApp: להגדיר עכשיו? (y/N) " yn
    if [ "${yn:-n}" = "y" ]; then
      read -r -s -p "WhatsApp permanent access token: " T; echo; printf '%s' "$T" | mksecret noni-wa-token; unset T
      read -r -s -p "Meta App Secret: " AS; echo; printf '%s' "$AS" | mksecret noni-wa-app-secret; unset AS
      openssl rand -hex 16 | tr -d '\n' | mksecret noni-wa-verify
      echo "Verify token ל-webhook ב-Meta: $(gcloud secrets versions access latest --secret=noni-wa-verify)"
    fi
  fi
  gcloud services enable calendar-json.googleapis.com cloudscheduler.googleapis.com >/dev/null
}
s_build() {
  step "בנייה"
  gcloud builds submit --region="$REGION" --gcs-source-staging-dir="gs://$PROJECT-build/source" \
    --tag "$REGION-docker.pkg.dev/$PROJECT/$REPO/$SERVICE:$(date +%Y%m%d-%H%M)" .
}
s_deploy() {
  step "פריסה ל-Cloud Run (ציבורי — הכניסה היא עם Google בתוך האפליקציה)"
  TAG=$(gcloud artifacts docker tags list "$REGION-docker.pkg.dev/$PROJECT/$REPO/$SERVICE" --format='value(tag)' | sort -r | head -1)
  echo "תגית: $TAG"
  SQL_IP=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(ipAddresses[0].ipAddress)')
  SECRETS="DB_PASS=noni-db-pass:latest,SESSION_SECRET=noni-session-secret:latest,CRON_KEY=noni-cron-key:latest,CONN_KEY=noni-conn-key:latest"
  gcloud secrets describe noni-google-client-id >/dev/null 2>&1 && SECRETS="$SECRETS,GOOGLE_CLIENT_ID=noni-google-client-id:latest,GOOGLE_CLIENT_SECRET=noni-google-client-secret:latest"
  gcloud secrets describe noni-telegram-token >/dev/null 2>&1 && SECRETS="$SECRETS,TELEGRAM_BOT_TOKEN=noni-telegram-token:latest"
  WA_ENV=""
  if gcloud secrets describe noni-wa-token >/dev/null 2>&1; then
    SECRETS="$SECRETS,WA_TOKEN=noni-wa-token:latest,WA_APP_SECRET=noni-wa-app-secret:latest,WA_VERIFY_TOKEN=noni-wa-verify:latest"
    WA_ENV=",WA_PHONE_ID=${WA_PHONE_ID:-},WA_DISPLAY_NUMBER=${WA_DISPLAY_NUMBER:-},WA_TEMPLATE_REMINDER=${WA_TEMPLATE_REMINDER:-}"
  fi
  gcloud run deploy "$SERVICE" --image="$REGION-docker.pkg.dev/$PROJECT/$REPO/$SERVICE:$TAG" --region="$REGION" --platform=managed \
    --service-account="$SA_EMAIL" --allow-unauthenticated \
    --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=private-ranges-only \
    --min-instances=0 --max-instances=5 --memory=512Mi --cpu=1 --concurrency=40 --timeout=120 \
    --set-env-vars="AUTH_MODE=google,REGION=$REGION,DB_HOST=$SQL_IP,DB_NAME=$DB_NAME,DB_USER=$DB_USER,LLM_PROVIDER=$LLM_PROVIDER,VERTEX_PROJECT=$PROJECT,VERTEX_REGION=$VERTEX_REGION,MODEL=$MODEL,GEMINI_MODEL=$GEMINI_MODEL,GEMINI_REGION=$GEMINI_REGION,PLATFORM_ADMINS=$PLATFORM_ADMINS,DEFAULT_TENANT=noni,RETENTION_DAYS=30,DAILY_LIMIT=100,GOOGLE_SCOPES=calendar gmail,PUBLIC_URL=${PUBLIC_URL:-},OAUTH_BASE=${PUBLIC_URL:-}$WA_ENV" \
    --set-secrets="$SECRETS"
  URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
  echo "$URL"
  if [ -z "${PUBLIC_URL:-}" ]; then
    gcloud run services update "$SERVICE" --region="$REGION" --update-env-vars="PUBLIC_URL=$URL,OAUTH_BASE=$URL" >/dev/null
    echo "PUBLIC_URL=$URL — לרשום בגוגל: Authorized JavaScript origin = $URL · Redirect URI = $URL/api/connect/google/callback"
  fi
}
s_cron() {
  step "Cloud Scheduler — תזכורות בווטסאפ כל דקה"
  URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
  KEY=$(gcloud secrets versions access latest --secret=noni-cron-key)
  gcloud scheduler jobs create http noni-reminders --location="$REGION" --schedule="* * * * *" --uri="$URL/api/cron/reminders" --http-method=POST --headers="X-Cron-Key=$KEY" 2>/dev/null \
    || gcloud scheduler jobs update http noni-reminders --location="$REGION" --schedule="* * * * *" --uri="$URL/api/cron/reminders" --http-method=POST --update-headers="X-Cron-Key=$KEY"
  unset KEY
}
s_provider() {
  P=${1:-gemini}
  gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars="LLM_PROVIDER=$P,GEMINI_MODEL=$GEMINI_MODEL,GEMINI_REGION=$GEMINI_REGION"
}

case "${1:-}" in
  db) s_db ;;
  sa) s_sa ;;
  secrets) s_secrets ;;
  build) s_build ;;
  deploy) s_deploy ;;
  cron) s_cron ;;
  provider) s_provider "${2:-gemini}" ;;
  all) s_db; s_sa; s_secrets; s_build; s_deploy ;;
  *) echo "שימוש: bash deploy-noni.sh {db|sa|secrets|build|deploy|cron|provider <gemini|vertex>|all}" ;;
esac
