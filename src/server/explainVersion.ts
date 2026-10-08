// Bumped with the shape of explanations: the browser asks again for anything
// older. Shared by the client (src/explain.ts) and the Worker (worker/index.ts)
// so the version stored in the explanation row and the version the Worker
// answers with never drift apart. 14 - explanations are built per
// solve frame over the acceptance set.
export const EXPLAIN_VERSION = 14
