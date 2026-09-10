# שרת החשבונות של החנות

Node.js 22 + Firebase Admin SDK + OpenAI Responses API. אותו שירות Cloud Run מטפל גם בנתונים וגם בסריקות. לא יוצרים Firebase project, מסד נוסף או Cloud Run נוסף.

**הסטטוס והשלמת ההפעלה:** ראו [מדריך ההפעלה באפליקציה](https://github.com/asafkiri/kiri-store-accounting/blob/main/docs/SETUP.md). קוד מוכן אינו הוכחה לפריסה בענן; SMS אמיתי וסריקת Luna מחייבים בדיקה לאחר פריסה עם החשבון המורשה.

## הארכיטקטורה והאבטחה

דפדפן → Firebase Phone Auth → Firebase ID token → Firebase Hosting `/api/**` → Cloud Run → Firebase Admin → Firestore / Storage.

`GET /health` פתוח לבדיקת בריאות בלבד. כל `/api/v1/*` דורש Bearer ID token מאומת באמצעות `verifyIdToken(token, true)` (כולל בדיקת ביטול). נדרש provider מסוג phone. `ALLOWED_PHONE_NUMBER` משווה מספר מאומת בפורמט E.164. אם גם `ALLOWED_UID` מוגדר, נדרשת התאמה לשניהם. אם מוגדר רק UID, הוא מזהה המשתמש המותר. אין allowlist בקוד/בדפדפן/Rules; בלי allowlist מתקבל 503 והנתונים חסומים.

Firestore ו־Storage חסומים ישירות לכל client. ה־Admin SDK פועל בהרשאות IAM של שירות הענן. אין שימוש ב־Realtime Database. OTP למספר אחר אינו נחסם כאן: גם אם התחבר, ה־API יחזיר 403.

## משתני סביבה

| שם | ערך / שימוש |
|---|---|
| `FIREBASE_PROJECT_ID` | `kiri-store-accounting` |
| `FIREBASE_STORAGE_BUCKET` | `kiri-store-accounting.firebasestorage.app` |
| `OPENAI_API_KEY` | ההפניה הקיימת ל־Secret Manager; לא מפתח בקוד |
| `OPENAI_MODEL` | `gpt-5.6-luna` בלבד. ערך אחר מונע עלייה של V1 |
| `ALLOWED_PHONE_NUMBER` | המספר המורשה הפרטי, E.164; סוד או env מוגן בצד השרת |
| `ALLOWED_UID` | אופציונלי; מצמצם את הגישה אם מוגדר בנוסף למספר |
| `ALLOWED_ORIGIN` | שני דומייני Firebase Hosting, מופרדים בפסיק; בלי `*` |
| `MAX_SCANS_PER_DAY` | ברירת מחדל 30; מונה משותף לכל instances |
| `MAX_SCANS_PER_MONTH` | ברירת מחדל 300; סריקות דוח וחשבונית נספרות יחד |
| `PORT` | Cloud Run מספק; ברירת מחדל 8080 |
| `NODE_ENV` | `production` בענן |

מונה הסריקות הוא הגנה על מספר בקשות, **לא תקרת חיוב בשקלים**. גם ניסיון שנכשל אחרי שמירת העבודה נספר. אין retry אוטומטי ואין מודל חלופי. התרעת התקציב בחשבון הענן נשארת התרעה בלבד.

## פיתוח, בדיקות ו־Docker

```sh
npm ci
npm test
npm run build
```

`build` בודק תחביר בכל מודולי השרת והבדיקות. קוד JavaScript ESM אינו דורש transpilation. הבדיקות משתמשות ב־store מבודד, HTTP מקומי, תמונות/PDF אמיתיים שנוצרו לבדיקה ו־OpenAI מדומה; הן אינן צורכות SMS או קריאות AI בתשלום. ה־Dockerfile מריץ את הבדיקות שוב בתוך שלב build, ולכן image אינו נבנה אם הן נכשלות.

```sh
cp .env.example .env
# ערוך .env מקומית בלבד. Cloud Run משתמש ב־Application Default Credentials של ה־service account.
gcloud auth application-default login
npm run dev
```

פיתוח מול הפרויקט האמיתי משנה נתוני אמת. לבדיקות מבודדות השתמש ב־`npm test`, או באמולטורים כמפורט ב־`docs/EMULATOR.md`. אף פעם אין לבטל authorization בקוד כדי לפתח. לא שומרים קובץ service-account בריפו.

```sh
docker build -t kiri-accounting-api .
docker run --rm -p 8080:8080 --env-file .env kiri-accounting-api
```

לצורך גישה ל־Firestore מ־Docker מקומי דרושות ADC מתאימות המועברות מקומית ובקריאה בלבד; בדיקת `/health` אינה דורשת אותן. אין צורך ב־Docker מקומי לפריסת Cloud Build.

## פריסה לשירות הקיים

השירות `kiri-store-accounting-ai-scan`, אזור `us-east1`, מחובר ל־`main` דרך Cloud Build. ה־Dockerfile נמצא בשורש ותואם לטריגר הקיים. אין ליצור טריגר/שירות חלופי.

1. ודא שב־Cloud Build → History מופיע build של ה־commit שהועלה ושהוא הצליח.
2. Cloud Run → השירות הקיים → Revisions: ה־revision האחרון Ready ומקבל 100% מהתעבורה.
3. שמור את ההפניה הקיימת `OPENAI_API_KEY → OPENAI_API_KEY:latest` ואת ה־service account הקיים `firebase-adminsdk-fbsvc@kiri-store-accounting.iam.gserviceaccount.com`.
4. הגדר את המספר המורשה בצד השרת בלבד, לפי מדריך ההפעלה.
5. השאר min=0, max=2, concurrency=2, 512 MiB, CPU=1, timeout=60 seconds, request-based billing.
6. אפשר ל־Firebase Hosting להגיע לשירות (public invocation ברמת Cloud Run); ה־ID token וה־allowlist נבדקים בתוך כל API. אין להחליף זאת בהסתמכות על ה־frontend.

```sh
gcloud run services describe kiri-store-accounting-ai-scan \
  --project=kiri-store-accounting --region=us-east1 \
  --format='value(status.url)'
# GET <הכתובת שהוחזרה>/health חייב להחזיר {"ok":true,...}.
# GET <הכתובת>/api/v1/me ללא Authorization חייב להחזיר 401.
```

## נתונים ועסקאות

כל הנתונים תחת `stores/family`. מזהי הרשומות נוצרים מראש בדפדפן ונשמרים בטיוטה. סכומים הם integer agorot; תאריכים עסקיים `YYYY-MM-DD`; `createdAt/updatedAt` הם server timestamps ומוחזרים ל־client ב־milliseconds.

| Collection | שימוש |
|---|---|
| `suppliers` | שם, קשר, הערות, active, גרסה ומטא־נתונים |
| `invoices` | ספק, מספר, סוג, תאריך, סכומים, הפחתות, payment, status, מסמכים, מקור, סקירה, גרסה, soft delete |
| `dailyCash` | ID שהוא תאריך; cashAgorot ו־ravKavAgorot נפרדים, null שונה מאפס |
| `documents` | שם/סוג/גודל/עמודים; ה־ID הוא SHA-256 של הקובץ |
| `scanJobs` | fingerprint, מצב, תוצאה מובנית, מסמכים, פקיעה ומטא־נתונים |
| `mutations` | receipt למניעת שכפול, fingerprint, פעולה ועותק קודם לצורכי audit |
| `invoiceKeys` | מפתח ספק+סוג+מספר למניעת חשבוניות כפולות |
| `changes` | יומן גרסאות לסנכרון מצטבר |
| `system` | גרסת נתונים, נעילת סריקה ומוני שימוש |

אין יתרת ספק נפרדת. הסכום הפתוח מחושב מחשבוניות פעילות שלא שולמו. `payment.paymentDate` הוא יום התשלום/מסירת הצ׳ק. `payment.checkDueDate` שדה עצמאי. עריכת חשבונית אינה מאפסת תשלום.

לכל write נדרשים `expectedVersion` ו־`mutationId`. העסקה קוראת את הגרסה, מפתח הכפילות ו־receipt לפני כל כתיבה. retry עם אותו payload ואותו ID מחזיר את הרשומה בלי write כפול; שינוי payload באותו ID או גרסה ישנה מחזיר 409. receipts ו־audit נשמרים ללא מחיקה אוטומטית ב־V1.

## חוזה API v1

תגובות שגיאה: `{ "error": { "code": "...", "message": "הודעה בעברית", "requestId": "..." } }`.

| Method | Endpoint | תוצאה |
|---|---|---|
| GET | `/health` | liveness בלבד, לא בדיקת הרשאות/AI |
| GET | `/api/v1/me` | UID מורשה; לא מחזיר מספר טלפון |
| GET | `/api/v1/sync?since=N` | snapshot ראשון / רשומות שהשתנו / unchanged |
| GET | `/api/v1/suppliers`, `/invoices`, `/daily-cash` | עמוד עד 250 רשומות; `after`, `limit` |
| GET | אותם נתיבים עם `/:id` | רשומה אחת |
| PUT | אותם נתיבים עם `/:id` | `{expectedVersion,mutationId,data}` |
| POST | `/api/v1/invoices/:id/pay` | `{expectedVersion,mutationId,payment}` |
| POST | `/api/v1/invoices/:id/unpay` | החזרה ללא שולם, עם גרסה ומזהה פעולה |
| DELETE | `/api/v1/invoices/:id` | soft-delete; JSON עם גרסה ומזהה פעולה |
| POST | `/api/v1/invoices/:id/restore` | שחזור מחיקה, עם גרסה ומזהה פעולה |
| POST | `/api/v1/documents` | `{files:[{name,mime,data:base64}]}` → מסמכים שמורים |
| GET | `/api/v1/documents/:sha256` | תוכן הקובץ לאחר authorization; no-store |
| POST | `/api/v1/scan-invoice`, `/scan-report` | `{jobId,attachmentIds}` → עבודת סריקה |
| GET | `/api/v1/scan-jobs/:id` | בדיקת תוצאה אחרי ניתוק; אינה מפעילה AI |
| GET | `/api/v1/reports/summary` | סיכום ושדות חסרים, לפי פילטרים |
| POST | `/api/v1/reconcile` | `{jobId,from,to}` → התאמות ודורש בדיקה; ללא שינוי חשבוניות |
| GET | `/api/v1/backup` | JSON schemaVersion 1; ללא קובצי צילום בינאריים |

פילטרים לחשבוניות/סיכום: `month`, `from`, `to`, `supplierId`, `status`, `method`, `q`. החודש והטווח מתייחסים לתאריך החשבונית. ייצוא חודשי CSV והדפסה ל־PDF מבוצעים ב־client מתוך אותה תצוגה. snapshot ראשון וקבלת גיבוי מלא קוראים את כל הרשומות; לאחר מכן אין polling, ו־sync משתמש ביומן גרסאות. מעבר ל־200 שינויים בין טעינות מביא snapshot חדש.

## סריקה ופרטיות

עד 8 עמודים ו־12 MiB בסך הכול, JSON upload עד 17 MiB. MIME/signature ו־decode מאומתים: JPEG/PNG/WebP עם עמוד יחיד, PDF לא מוצפן; SVG/אנימציה/קובץ פגום נדחים. תמונה עד 24 מיליון פיקסלים כדי להגן על 512 MiB. המקור נשמר בלי crop או sharpen אגרסיבי. הקבצים אינם ציבוריים ואין download tokens. SHA-256 מונע upload כפול לאותו תוכן.

סריקה אחת פעילה לכל החנות באמצעות Firestore lease, גם כשיש שני instances. timeout לקריאת OpenAI 38 שניות; אין retry אוטומטי. תוצאה נשמרת כעבודת סריקה, לא כחשבונית. jobId מאפשר לאחזר תשובה שנאבדה ברשת. בקשה זהה שהושלמה לא מפעילה שוב AI; עבודה שנכשלה דורשת בחירה מפורשת להתחיל חדשה.

Structured Outputs קבוע + validation עצמאי בשרת. שדות חסרים/לא ודאיים נשארים null ומסומנים `needsReview`. מע״מ אפס דורש עדות מפורשת; אין הנחת שיעור מע״מ. אי־התאמה אריתמטית מסומנת בלי לשנות אף מספר מודפס. הדפדפן דורש סקירה ולחיצת שמירה. שדה `reviewConfirmed` נאכף גם בשרת, אך כמובן שהשרת אינו יכול לדעת אם אדם אכן בדק בעיניו.

לוגים מכילים request ID, endpoint ללא query, method, duration, status, model וקטגוריית שגיאה בלבד. אין tokens, טלפונים, SMS, תמונות, מפתח או טקסט חשבונית בלוג. `store:false` נשלח ל־OpenAI; זאת אינה הבטחה ל־Zero Data Retention של חשבון OpenAI.

קבצים שהועלו ולא צורפו בסוף נשמרים כטיוטות שרת ב־V1. אין מחיקת קבצים אוטומטית כדי למנוע אובדן מסמך; יש לנטר נפח ולתכנן ניקוי מבוקר בהמשך. גיבוי JSON אינו כולל קבצים בינאריים; לשחזור מלא צריך גם גיבוי bucket ו־Firestore מתאים. אין Import שדורס נתונים.

## תיעוד רשמי

- [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Firebase Hosting → Cloud Run](https://firebase.google.com/docs/hosting/cloud-run)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)

תלות מעבר: `gaxios@6.7.1` משתמשת רק ב־`uuid.v4`; הוגדר override ל־`uuid@11.1.1` כדי להסיר גרסה עם חולשת bounds check. ה־override מוגדר ישירות לפי שם החבילה, כך שגם npm 10 שמגיע עם Node 22 ב־Docker מכבד אותו בהתקנה נקייה. החיבור ל־Storage נבדק מחדש באמולטור אחרי העדכון.
