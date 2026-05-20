/** True when an executor operation failed because the target path is absent. */
export function isNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
