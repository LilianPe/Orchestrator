export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface LinearGqlError {
  message: string;
  extensions?: { userPresentableMessage?: string };
}

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly errors: LinearGqlError[] = [],
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
    const json = (await res.json()) as { data?: T; errors?: LinearGqlError[] };
    if (json.errors?.length) throw new LinearApiError(json.errors.map((e) => e.message).join('; '), json.errors);
    if (!res.ok) throw new LinearApiError(`HTTP ${res.status}`);
    return json.data as T;
  }
}
