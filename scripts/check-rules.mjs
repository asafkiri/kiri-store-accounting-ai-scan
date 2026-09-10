import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
// CI checks out the app separately; local checkouts can be adjacent.
const app = resolve(process.argv[2] || "../kiri-store-accounting");
for (const name of ["firestore.rules", "storage.rules"]) {
  const deployed = await readFile(resolve(app, name));
  const tested = await readFile(new URL("../test/" + name, import.meta.url));
  if (!deployed.equals(tested))
    throw Error(`${name}: emulator rules differ from the app's deployed rules`);
}
console.log("Emulator rules match the app's deployment files byte-for-byte");
