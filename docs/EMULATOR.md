# בדיקת Firebase מקומית ומבודדת

הבדיקה משתמשת בפרויקט אמולטור בשם `demo-kiri-accounting`. זה **אינו Firebase project בענן**: אין יצירה/שימוש בפרויקט ייצור, SMS אמיתי או קריאה בתשלום ל־OpenAI.

דרושים Node.js 22+, Java 17+ ו־Firebase CLI. יש להחזיק את ריפו האפליקציה בתיקייה סמוכה בשם `kiri-store-accounting`. לאחר `npm ci`:

```sh
node scripts/check-rules.mjs ../kiri-store-accounting &&
npx firebase-tools@14.16.0 emulators:exec \
  --project demo-kiri-accounting \
  --config firebase.emulators.json \
  --only auth,firestore,storage \
  'npm run test:emulator'
```

האמולטורים מאזינים ל־127.0.0.1 בלבד, בפורטים 9099, 8081 ו־9199. אין API backend שקבוע במצב בדיקה; מבחן השילוב מרכיב את אותם `firebaseServices` ו־HTTP handler עם סריקת AI מדומה בלבד. ה־token נוצר ב־Phone Auth emulator ומאומת דרך Admin SDK. ללא שלושת משתני ה־emulator הבדיקה נעצרת, כדי למנוע גישה לייצור.

הבדיקה מכסה: משתמש מורשה/לא מורשה, server timestamps, יצירת חשבונית, idempotency, התנגשות גרסאות, תשלום בצ׳ק עם שני התאריכים, רישום קופה ורב־קו, שמירה/קריאה של קובץ Storage, snapshot וחסימת Firestore/Storage ישירות ל־client. כללי האמולטורים ב־`test/*.rules` נבדקים בזהות בתים מול קובצי הכללים שנפרסים מריפו האפליקציה. CI בשני הריפוזיטוריז נכשל אם הכללים שונים. חסימת Storage עם token תקף חייבת להחזיר 403; 401 אינו נחשב הוכחה לחסימת Rules.

`NODE_ENV=production` יחד עם משתנה emulator יגרום לשרת להיעצר. אין להגדיר משתני emulator ב־Cloud Run.

הצלחה כאן אינה מאמתת הרשאות IAM בענן, SMS אמיתי, קיומו של המודל בחשבון OpenAI או פריסה. בדיקת הקצה בטלפון מתועדת במדריך ההפעלה של האפליקציה.
