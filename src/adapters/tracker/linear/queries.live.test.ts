import { buildClientSchema, getIntrospectionQuery, parse, validate, type IntrospectionQuery } from 'graphql';
import { describe, expect, it } from 'vitest';
import { Q } from './queries.js';

const key = process.env['LINEAR_API_KEY'];

describe.skipIf(!key)('Linear documents against the live schema', () => {
  it('every document validates', async () => {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key! },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    const { data } = (await res.json()) as { data: IntrospectionQuery };
    const schema = buildClientSchema(data);
    for (const [name, doc] of Object.entries(Q)) {
      const errors = validate(schema, parse(doc)).map((e) => e.message);
      expect({ name, errors }).toEqual({ name, errors: [] });
    }
  });
});
