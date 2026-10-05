import base from '../../../../vitest.config.mts';

/**
 * The suite's own configuration, setup files and run guard included, on the
 * fixtures beside this file and nothing else. tmpdir-isolation.test.ts runs
 * vitest on them in a child; the suite's own run never picks them up, since it
 * takes only *.test.ts files.
 */
const config = { ...base, test: { ...base.test, include: ['__tests__/setup/fixtures/tmpdir-guard/*.fixture.ts'] } };
export default config;
