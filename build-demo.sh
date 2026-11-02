#!/bin/bash
# בונה את demo/index.html מתוך public/index.html: מצב דמו קבוע, כותרת "דמו", כתובת הדמו ב-OG
set -e
cd "$(dirname "$0")"
D=${DEMO_URL:-https://noni-demo.timeline-school.com}
sed -e "s#__PUBLIC_URL__#$D#g" \
    -e 's#<title>Noni · נוני, העוזרת האישית</title>#<title>Noni · דמו</title>#' \
    -e 's#og:title" content="Noni · נוני, העוזרת האישית שלי"#og:title" content="Noni · דמו — נוני, העוזרת האישית שלי"#' \
    -e 's#^<body>$#<body>\n<script>window.ASSIST_DEMO=true;</script>#' public/index.html > demo/index.html
cp public/og.png demo/og.png 2>/dev/null || true
mkdir -p public/demo && cp demo/index.html public/demo/index.html   # מוגש גם מהשרת ב-/demo/ (ה-Worker של noni-demo מושך משם)
echo "demo/index.html נבנה ($D)"
