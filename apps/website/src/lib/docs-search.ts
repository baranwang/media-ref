import { createFromSource } from "fumadocs-core/search/server";
import { docsSource } from "./docs-source";

/** Full-text search over the docs; the index is built on the first query. */
export const docsSearch = createFromSource(docsSource);
