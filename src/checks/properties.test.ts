import { describe, expect, it } from 'vitest';
import { missingProperties, propertySupport, propertyTestFiles, propertyTests } from './properties.js';

describe('the property test files the factory names (ORC-261)', () => {
  it('names one file per approved property, by language', () => {
    expect(propertyTestFiles('ORC-12', 2)).toEqual({ ts: 'orc-12.property-2.test.ts', py: 'test_orc_12_property_2.py' });
  });

  it('finds each property its file, wherever the repository keeps its tests, in TS, JS or Python', () => {
    const paths = ['src/csv/orc-12.property-1.test.ts', 'tests/test_orc_12_property_2.py', 'web/orc-12.property-3.spec.jsx'];
    expect(missingProperties('ORC-12', 4, paths)).toEqual([4]);
  });

  it('does not take another ticket, another property number or a file that is no test for it', () => {
    const paths = ['orc-13.property-1.test.ts', 'orc-12.property-12.test.ts', 'orc-12.property-2.ts', 'orc-12.property-2.test.ts.snap'];
    expect(missingProperties('ORC-12', 2, paths)).toEqual([1, 2]);
  });

  it('tells the property tests from the other tests', () => {
    expect(propertyTests('ORC-12', 1, ['src/export.test.ts', 'src/orc-12.property-1.test.ts', 'src/orc-12.property-2.test.ts'])).toEqual(['src/orc-12.property-1.test.ts']);
  });

  it('wants nothing of a spec without properties', () => {
    expect(missingProperties('ORC-12', 0, [])).toEqual([]);
  });
});

describe('the generators of the property tests, frozen with them (ORC-261)', () => {
  const view = (files: Record<string, string>) => ({ filesAtHead: async () => Object.keys(files), showAtHead: async (p: string) => files[p] });

  it('follows the TS imports of a property test to the test files they reach, never the code under test', async () => {
    const files = {
      'test/orc-12.property-1.test.ts': "import fc from 'fast-check';\nimport { rows } from './arb/rows.js';\nimport { toCsv } from '../src/csv.js';\nexport { cell } from './arb';",
      'test/arb/rows.ts': "import { cell } from './cell';\nexport const rows = 1;",
      'test/arb/cell.ts': 'export const cell = 1;',
      'test/arb/index.ts': 'export const cell = 2;',
      'src/csv.ts': 'export const toCsv = 1;',
      'test/unrelated.ts': '',
    };
    expect(await propertySupport(['test/orc-12.property-1.test.ts'], view(files))).toEqual(['test/arb/cell.ts', 'test/arb/index.ts', 'test/arb/rows.ts']);
  });

  it('follows the Python imports, relative and from the repository root', async () => {
    const files = {
      'tests/test_orc_12_property_1.py': 'from hypothesis import given\nfrom .strategies import rows\nfrom . import cells\nimport tests.helpers.money as money\nfrom app.csv import to_csv\n',
      'tests/strategies.py': 'from tests.deep import x\n',
      'tests/cells.py': '',
      'tests/helpers/money.py': '',
      'tests/deep/__init__.py': '',
      'app/csv.py': '',
    };
    expect(await propertySupport(['tests/test_orc_12_property_1.py'], view(files))).toEqual(['tests/cells.py', 'tests/deep/__init__.py', 'tests/helpers/money.py', 'tests/strategies.py']);
  });

  it("resolves pytest's layouts: a tests folder without __init__.py, a project in a subfolder, a submodule imported by name, a parenthesized list", async () => {
    const files = {
      'backend/tests/test_orc_12_property_1.py': 'from strategies import rows\nfrom tests.arb import money\nfrom . import (\n    cells,\n    dates,\n)\n',
      'backend/tests/strategies.py': '',
      'backend/tests/arb/__init__.py': '',
      'backend/tests/arb/money.py': '',
      'backend/tests/cells.py': '',
      'backend/tests/dates.py': '',
      'backend/app/strategies.py': '',
    };
    expect(await propertySupport(['backend/tests/test_orc_12_property_1.py'], view(files))).toEqual([
      'backend/tests/arb/__init__.py', 'backend/tests/arb/money.py', 'backend/tests/cells.py', 'backend/tests/dates.py', 'backend/tests/strategies.py',
    ]);
  });

  it('leaves out the property tests themselves and a cycle of imports', async () => {
    const files = { 'test/orc-12.property-1.test.ts': "import './a';", 'test/a.ts': "import './orc-12.property-1.test';\nimport './a';" };
    expect(await propertySupport(['test/orc-12.property-1.test.ts'], view(files))).toEqual(['test/a.ts']);
  });
});
