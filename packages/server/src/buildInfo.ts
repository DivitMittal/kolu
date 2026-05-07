/** Build identity exposed to clients for deploy freshness checks. */

export const buildCommit = process.env.KOLU_COMMIT_HASH || "dev";
