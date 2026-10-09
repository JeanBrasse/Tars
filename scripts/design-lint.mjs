#!/usr/bin/env node
// Design guardrail: fails when banned styling creeps back in.
//
// Every rule reads the .ts, .tsx and .css files under src/: class names live in
// constants as well as in markup, and an @apply can carry a shadow or a raw
// colour into a stylesheet.
//
// The Node port of scripts/design-lint.sh, which needed bash and grep (on
// Windows, `bash` is the WSL launcher). Same six rules, written as the same
// POSIX extended regular expressions grep -E took, same exemptions, same lines
// printed, same exit codes. What it keeps of grep, on purpose:
//   - it walks src/ as grep -r does: directory order, depth first, symbolic
//     links met inside src/ not followed, regular files named *.ts, *.tsx or
//     *.css only;
//   - it reads bytes: a line ends at \n and nothing else, a NUL is text (grep
//     -a), and a line it prints is the file's own bytes, minus NULs, which the
//     shell's $(...) used to drop;
//   - the character classes are ASCII, as grep's are in the C.UTF-8 locale Git
//     Bash runs it in, measured on 2026-09-25: é next to a # is not [:alnum:].
//     So it is stricter than grep in a UTF-8 locale on macOS or Linux: a
//     non-ASCII letter or space beside a hex or before a comment marker can
//     make it flag a line grep let through, never the other way round.
//
// grep answered in three ways, and only one of them was a pass: 0 found a line,
// 1 found none, 2 could not search. Until 17/09 the shell script threw grep's
// errors away and read "no line left" as a pass: a src/ that did not exist, a
// pattern grep refused and a violation in a file grep could not open all
// printed five green ticks. Each of them fails here, and says so in grep's
// words, "(grep exited 2)", so that the output reads as it always did.

import fs from 'node:fs';
import path from 'node:path';

const SOURCES = ['.ts', '.tsx', '.css'];

// The paths whose job is to define raw appearance, left out of every rule, each
// with its reason. Matched against the start of the line printed for a hit,
// path:line:text, so a line that merely mentions one of them is still read.
let exempt = String.raw`^src/components/ui/`;   // the shared primitives: the one place raw appearance is defined
exempt += String.raw`|^src/app/icon\.tsx:`;     // drawn by next/og into an image, where no stylesheet or token reaches

// Two more for the hex rule alone, since a colour has to be written out
// somewhere, and a number is not always a colour.
let hexExempt = exempt;
hexExempt += String.raw`|^src/app/globals\.css:`;                                     // the token system: where every hex the app uses is named once
hexExempt += String.raw`|^src/[^:]*\.tsx?:[0-9]+:[[:space:]]*(//|\*([[:space:]]|$))`;  // a comment paints nothing, and "React #418" is an error number

/** The three POSIX classes the patterns use, as grep reads them here: ASCII. */
const CLASSES = { alnum: '0-9A-Za-z', xdigit: '0-9A-Fa-f', space: ' \\t\\n\\v\\f\\r' };

/**
 * A pattern written for grep -E, as a RegExp. Throws a SyntaxError where grep
 * would have refused it, a class it does not know included, rather than read it
 * as something else.
 */
function compile(ere) {
  const source = ere.replace(/\[:([a-z]+):\]/g, (whole, name) => {
    if (!Object.hasOwn(CLASSES, name)) throw new SyntaxError(`unsupported character class ${whole} in ${ere}`);
    return CLASSES[name];
  });
  return new RegExp(source);
}

/** The script's own lines, in UTF-8. */
const say = text => process.stdout.write(`${text}\n`);
/** A line of a source file, held one byte per character, printed back byte for byte. */
const show = bytes => process.stdout.write(Buffer.from(`${bytes}\n`, 'latin1'));

/** A file's lines as grep sees them: split at \n, the empty tail after a final \n not being a line. */
function linesOf(bytes) {
  const lines = bytes.toString('latin1').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Every file the rules read under `dir`, in the order grep -r reads them:
 * entries in directory order, each folder read through before its next
 * sibling. What could not be opened lands in `errors`, and the walk goes on,
 * as grep's does.
 */
function collect(dir, shown, files, errors) {
  const entries = [];
  let handle;
  try {
    handle = fs.opendirSync(dir);
    for (let entry; (entry = handle.readSync()) !== null;) entries.push(entry);
  } catch (err) {
    errors.push(err);
  } finally {
    handle?.closeSync();
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const name = `${shown}/${entry.name}`;
    if (entry.isDirectory()) {
      collect(full, name, files, errors);
    } else if (entry.isFile() && SOURCES.some(ext => entry.name.endsWith(ext))) {
      try {
        files.push({ name: Buffer.from(name).toString('latin1'), lines: linesOf(fs.readFileSync(full)) });
      } catch (err) {
        errors.push(err);
      }
    }
    // Anything else, a symbolic link above all, is left alone, as grep -r leaves it.
  }
}

/** What every rule reads: src/ itself is followed if it is a link, as grep follows a path it is given. */
function sources() {
  const files = [];
  const errors = [];
  try {
    if (fs.statSync('src').isDirectory()) collect('src', 'src', files, errors);
    // A src/ that is a file is read only if its own name ends like a source, which "src" never does.
  } catch (err) {
    errors.push(err);
  }
  return { files, errors };
}

function main() {
  // A rule that reads nothing finds nothing, and finding nothing is a pass. So
  // the files are counted, none is a failure, and so is one that could not be read.
  const { files, errors } = sources();
  for (const err of errors) process.stderr.write(`design-lint: ${err.message}\n`);
  if (errors.length > 0) {
    say('✗ could not read everything under src/ (grep exited 2)');
    return 1;
  }
  if (files.length === 0) {
    say('✗ no .ts, .tsx or .css file under src/: nothing was checked');
    return 1;
  }
  say(`${files.length} files read under src/`);

  let fail = 0;
  const check = (label, pattern, skip = exempt) => {
    let hits;
    try {
      const rule = compile(pattern);
      hits = [];
      for (const { name, lines } of files) {
        lines.forEach((line, i) => {
          if (rule.test(line)) hits.push(`${name}:${i + 1}:${line}`.replaceAll('\0', ''));
        });
      }
      // Lines found, minus the exempt paths. Only lines found reach the
      // exemptions, so a broken exemption shows only once something is found.
      if (hits.length > 0) {
        const set = compile(skip);
        hits = hits.filter(hit => !set.test(hit));
      }
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      process.stderr.write(`design-lint: ${err.message}\n`);
      say(`✗ ${label}: grep could not search (exit 2)`);
      fail = 1;
      return;
    }
    if (hits.length === 0) {
      say(`✓ ${label}`);
      return;
    }
    say(`✗ ${label}`);
    for (const hit of hits.slice(0, 8)) show(`    ${hit}`);
    if (hits.length > 8) say(`    … ${hits.length - 8} more`);
    fail = 1;
  };

  check('no inline border-radius', String.raw`style=\{\{ *borderRadius`);
  check('no drop shadows', String.raw`shadow-(sm|md|lg|xl|2xl)`);
  check('no gradients', String.raw`bg-gradient`);
  check('no decorative ping', String.raw`animate-ping`);
  check('no raw tailwind palette', String.raw`(text|bg|border)-(red|green|blue|amber|purple|cyan|yellow|orange|zinc|slate|gray)-[0-9]`);
  // Three, four, six or eight hex digits standing on their own: #fff, #1a1a1aff,
  // and the same inside a class, a style or a stylesheet. Not &#8226;, which is an
  // HTML entity, and not #12345, which is no colour at all.
  check('no hardcoded hex colour', String.raw`(^|[^&[:alnum:]_])#([[:xdigit:]]{3}|[[:xdigit:]]{4}|[[:xdigit:]]{6}|[[:xdigit:]]{8})([^[:alnum:]_]|$)`, hexExempt);

  return fail;
}

process.exitCode = main();
