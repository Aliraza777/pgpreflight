import { createRequire } from "node:module";

/** package.json sits one level up from both src/ and the built dist/. */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
