import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const normalize = (value) => {
  if (value == null || typeof value !== "object") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (Array.isArray(value)) return value.map(normalize);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, normalize(v)]),
  );
};
export function firebaseServices(config) {
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: config.projectId,
    storageBucket: config.bucket,
  });
  const db = getFirestore(app);
  const root = db.collection("stores").doc("family");
  const ref = (key) =>
    root.collection(key.split("/")[0]).doc(key.split("/")[1]);
  return {
    verifyToken: (token) => getAuth(app).verifyIdToken(token, true),
    store: {
      get: async (key) => {
        const s = await ref(key).get();
        return s.exists ? normalize(s.data()) : null;
      },
      list: async (collection, after = "", limit = 250) => {
        let q = root
          .collection(collection)
          .orderBy(FieldPath.documentId())
          .limit(limit);
        if (after) q = q.startAfter(after);
        return (await q.get()).docs.map((d) => normalize(d.data()));
      },
      transaction: (fn) =>
        db.runTransaction(async (native) =>
          fn({
            get: async (key) => {
              const s = await native.get(ref(key));
              return s.exists ? s.data() : null;
            },
            list: async (collection) =>
              (await native.get(root.collection(collection))).docs.map((d) =>
                d.data(),
              ),
            set: (key, data) => native.set(ref(key), data),
            stamp: () => FieldValue.serverTimestamp(),
          }),
        ),
    },
    storage: {
      put: async (key, bytes, mime) => {
        try {
          await getStorage(app)
            .bucket()
            .file(key)
            .save(bytes, {
              resumable: false,
              validation: "crc32c",
              contentType: mime,
              metadata: { cacheControl: "private, no-store" },
              preconditionOpts: { ifGenerationMatch: 0 },
            });
        } catch (e) {
          if (Number(e.code) !== 412) throw e;
        }
      },
      get: async (key) =>
        (await getStorage(app).bucket().file(key).download())[0],
    },
  };
}
