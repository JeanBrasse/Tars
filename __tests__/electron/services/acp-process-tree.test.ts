import { describe, it, expect } from 'vitest';
import { ProcessTree, parseProcessTable } from '../../../electron/services/acp/client';

/**
 * The process tree a stopped delegated run is ended by (#197, #199): read from
 * ps before the first signal, and read again before the last, from every
 * process already known.
 *
 * Between the two reads a known process may end and its id be given to another
 * process, anyone's. Read again, that id is still "known", so its group, and
 * any child of it, were taken for the run's and signalled (the Audit's gate of
 * #199). Matching (pid, ppid) pairs does not tell them apart: launchd is the
 * parent of a reparented process and of many a new one. The age ps gives does:
 * a process younger than the time since the first read did not exist then.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A known pid taken by an unrelated process between the reads has that
 *    process's group signalled.
 * 2. A child of such a process is adopted as the run's; or, when the new
 *    process leads a group of its own, that group has the id of one of the
 *    run's, and is signalled under it.
 * 3. Over-correction: a known process that is still the same one is dropped,
 *    and its group or the child it started between the reads is left running.
 * 4. Over-correction: a process started between the reads by a known one is
 *    dropped for being young.
 * 5. ps's age is misread: `mm:ss`, `hh:mm:ss` and `d-hh:mm:ss` are all seconds.
 * 6. A ps that gives no age (busybox) makes every known process a stranger:
 *    with no age, nothing is dropped, as before.
 *
 * ps gives the age in whole seconds, so a process given a known id less than a
 * second after the first read is not told apart. That is the part left open.
 */

const row = (pid: number, ppid: number, pgid: number, etime?: string) =>
  `${pid} ${ppid} ${pgid} S${etime === undefined ? '' : ` ${etime}`}`;
const table = (...rows: string[]) => parseProcessTable(rows.join('\n'));

const T0 = 1_000_000;

describe('the second read of a run\'s process tree', () => {
  it('1, 2. takes nothing from a known pid that another process took since the first read', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100, '05:00'), row(200, 100, 200, '04:00')), T0);
    expect(tree.targets.sort()).toEqual([100, 200]);

    // 200 ended; its id went to someone else's shell (group 900), which started 901.
    tree.grow(table(row(100, 1, 100, '05:05'), row(200, 1, 900, '00:01'), row(901, 200, 901, '00:01')), T0 + 5_000);

    expect(tree.targets).not.toContain(900);
    expect(tree.targets).not.toContain(901);
  });

  it('2. leaves a group alone whose id a new process took by leading it', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100, '05:00'), row(200, 100, 200, '04:00')), T0);

    // Group 200 ended with its leader; a new process got pid 200 and leads a group of that id.
    tree.grow(table(row(100, 1, 100, '05:05'), row(200, 1, 200, '00:01')), T0 + 5_000);

    expect(tree.targets).toEqual([100]);
  });

  it('3, 4. keeps a known process that is the same one, and what it started in between', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100, '05:00'), row(200, 100, 200, '04:00')), T0);

    tree.grow(table(row(100, 1, 100, '05:05'), row(200, 100, 200, '04:05'), row(300, 200, 300, '00:02')), T0 + 5_000);

    expect(tree.targets.sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('5. reads every form of ps\'s age', () => {
    expect(table(row(1, 0, 1, '07'), row(2, 0, 2, '01:07'), row(3, 0, 3, '02:01:07'), row(4, 0, 4, '3-02:01:07'))
      .map(r => r.age)).toEqual([7, 67, 7267, 3 * 86_400 + 7267]);
  });

  it('6. drops nothing when ps gives no age', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100), row(200, 100, 200)), T0);

    tree.grow(table(row(100, 1, 100), row(200, 100, 200), row(300, 200, 300)), T0 + 5_000);

    expect(tree.targets.sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });
});
