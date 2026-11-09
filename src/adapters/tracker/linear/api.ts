export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface LinearGqlError {
  message: string;
  /** The field it is about, as GraphQL gives it: `['issue']` for the issue a query names. */
  path?: readonly (string | number)[];
  /**
   * `code`: `RATELIMITED` for Linear's rate limit, which it answers with a 400 (ORC-343). `type`: its kind, `invalid input`
   * for an identifier Linear does not have.
   */
  extensions?: { userPresentableMessage?: string; code?: string; type?: string };
}

/** A refusal of Linear's API: its GraphQL errors, and the HTTP status it came with (`isTransient` reads both, ORC-343). */
export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly errors: LinearGqlError[] = [],
    readonly status?: number,
  ) {
    super(message);
  }
}

export class LinearApi {
  constructor(
    private getToken: () => Promise<string>,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private endpoint = 'https://api.linear.app/graphql',
  ) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.getToken()}` },
      body: JSON.stringify({ query, variables }),
    });
    // A 502 from a proxy in front of Linear has an HTML body: its status still tells what failed.
    const json = (await res.json().catch((err: unknown) => {
      if (res.ok) throw err;
      return {};
    })) as { data?: T; errors?: LinearGqlError[] };
    if (json.errors?.length) throw new LinearApiError(json.errors.map((e) => e.message).join('; '), json.errors, res.status);
    if (!res.ok) throw new LinearApiError(`HTTP ${res.status}`, [], res.status);
    return json.data as T;
  }
}
