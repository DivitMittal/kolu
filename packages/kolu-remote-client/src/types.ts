/** Narrow interface the remote providers depend on. Decouples this
 *  package from `kolu-server`'s `HostSession` class — tests pass in a
 *  mock with the same shape. */
export interface HostSessionLike {
  call(method: string, args: unknown): Promise<unknown>;
  subscribe<UpdateParams = unknown>(
    method: string,
    args: unknown,
    onEvent: (payload: unknown) => void,
  ): {
    update(params: UpdateParams): Promise<void>;
    close(): Promise<void>;
  };
}
