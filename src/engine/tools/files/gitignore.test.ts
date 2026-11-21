// gitignore — the walk-scoped `.gitignore` subset ./gitignore.ts commits to.
//
// What has to stay true, pin by pin (the documented subset is the header comment of
// ./gitignore.ts "MATCHING RULES"; every expectation below is derived from it, and every
// compiled RegExp source is hardcoded from that derivation):
//
//   - compilation: `* ? [abc] [!abc] **/ /** **` and `\x` behave as documented, an
//     unterminated `[` is a literal, and an unanchored body gets the "zero or more
//     directories" prefix so it matches at any depth;
//   - parsing: comments and blank lines are skipped, trailing spaces are insignificant
//     unless escaped, `!` / a leading `/` / a trailing `/` are MARKERS that are stripped
//     from the body (the leading-slash regression: leaving it in compiles `^/Temp$`,
//     which can never match the root-relative path `Temp`), a lone `!` or `/` is not a
//     pattern, and each rule records the `base` that owns it;
//   - matching: a rule may match the path itself or any ancestor of it (`dist/` excludes
//     `dist/app.js` through the `dist` level), a directory-only rule cannot match a file,
//     the last match in load order wins, a deeper `.gitignore` overrides a shallower one,
//     and a rule never reaches outside the subtree that owns it;
//   - the matcher's caps and tolerances: a missing/unreadable `.gitignore` (including a
//     DIRECTORY named `.gitignore`) is not an error, one oversized file is parsed up to
//     `MAX_GITIGNORE_BYTES`, and after `MAX_GITIGNORE_FILES` load attempts further files
//     are skipped — all of it observable through `stats()`;
//   - the walker's `present` hint: a directory the walk already knows has no `.gitignore`
//     costs no open and no cap budget, so `MAX_GITIGNORE_FILES` bounds FILES PARSED rather
//     than directories visited (the distinction that let the cap rise, and the reason
//     `stats()` reports `files` and `directories` separately).
//
// `isIgnored` takes POSIX root-relative paths, so no cwd is needed here (unlike
// ./glob.test.ts and ./grep.test.ts): the fixture tree only feeds `load`, which takes an
// absolute directory plus the relative directory it stands for. Fixtures live under the
// repo-root `Temp/`, one unique directory per run, removed afterwards.
//
// TWO KNOWN DEVIATIONS, each pinned by the test named after it (both assertions follow
// the documented contract above, not the current output):
//
//   1. 'keeps a single * inside one path segment' — gitignore.ts `compileGitignorePattern`
//      routes a SINGLE star run through the `**` branch and emits `.*`, so `src/*.ts` also
//      matches `src/nested/a.ts`. gitignore(5), and this module's own "MATCHING RULES"
//      header, scope `*` to one segment. Every other expectation here avoids a bare single
//      `*` in its expected RegExp source, so the fix flips exactly one test.
//   2. 'keeps matching usable when one line fills the whole byte bound' — a bound-cut file
//      that leaves one ~256 KiB literal pattern makes V8 refuse to EXECUTE the compiled
//      rule: `new RegExp` succeeds and the first `rule.source.test(candidate)` inside
//      `isIgnored` throws `SyntaxError: Invalid regular expression: …: Regular expression
//      too large`. ./glob.ts `walkFiles` calls `isIgnored` outside its only try/catch, so
//      the whole walk fails instead of merely costing rules.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    GITIGNORE_FILE_NAME,
    MAX_GITIGNORE_BYTES,
    MAX_GITIGNORE_FILES,
    compileGitignorePattern,
    createGitignoreMatcher,
    parseGitignore
} from './gitignore';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

// One unique case directory per matcher, so a rule set written for one case can never
// leak into another case's rule list.
let caseIndex = 0;

// The compiled shape as plain data: `String(source)` shows the pattern between slashes,
// which keeps these literal expectations readable.
const compiledShape = (pattern: string): { anchored: boolean; source: string } => {
    const compiled = compileGitignorePattern(pattern);
    return { anchored: compiled.anchored, source: String(compiled.source) };
};

// Parsed rules as plain data, for the whole-document expectations.
const ruleShapes = (content: string, base = ''): Array<Record<string, unknown>> =>
    parseGitignore(content, base).map((rule) => ({
        base: rule.base,
        negation: rule.negation,
        directoryOnly: rule.directoryOnly,
        anchored: rule.anchored,
        source: String(rule.source)
    }));

// Writes one fixture at an ABSOLUTE path, creating its parent directory.
const writeAt = async (absolutePath: string, content: string): Promise<void> => {
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeTextFile(absolutePath, content, 'utf8');
};

// The absolute directory a relative base stands for inside a case directory; '' is the
// search root itself.
const absoluteFor = (caseDirectory: string, relativeDirectory: string): string =>
    relativeDirectory.length === 0
        ? caseDirectory
        : join(caseDirectory, ...relativeDirectory.split('/'));

// One fresh matcher loaded from `entries` in load order (outer directory first), which is
// the order a depth-first walk visits them in.
const loadMatcher = async (
    entries: Array<[string, string]>
): Promise<ReturnType<typeof createGitignoreMatcher>> => {
    const caseDirectory = join(workdir, `case-${caseIndex++}`);
    const matcher = createGitignoreMatcher();

    for (const [relativeDirectory, content] of entries) {
        const absoluteDirectory = absoluteFor(caseDirectory, relativeDirectory);
        await writeAt(join(absoluteDirectory, GITIGNORE_FILE_NAME), content);
        await matcher.load(absoluteDirectory, relativeDirectory);
    }

    return matcher;
};

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-gitignore-'));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('gitignore pattern compilation', () => {
    it('publishes the file name and the two caps as exported constants', () => {
        // The numbers a caller reads out of `stats()` are these, so a host cannot
        // quietly widen them.
        expect(GITIGNORE_FILE_NAME).toBe('.gitignore');
        expect(MAX_GITIGNORE_BYTES).toBe(262144);
        // 2048, not the 512 that fired on a repository with more than 512 DIRECTORIES:
        // the cap bounds real parses, and a repo-wide walk of this package makes seven.
        expect(MAX_GITIGNORE_FILES).toBe(2048);
    });

    it('compiles the documented pattern set to the exact expected sources', () => {
        // Derived by hand from the documented subset and then hardcoded: an unanchored
        // body is prefixed with one "zero or more directories" group (gitignore.ts
        // line 187), and RegExp.prototype.source escapes every '/'.
        expect(compiledShape('secret')).toEqual({ anchored: false, source: '/^(?:[^/]*\\/)*secret$/' });
        expect(compiledShape('node_modules')).toEqual({
            anchored: false,
            source: '/^(?:[^/]*\\/)*node_modules$/'
        });
        expect(compiledShape('Temp')).toEqual({ anchored: false, source: '/^(?:[^/]*\\/)*Temp$/' });
        expect(compiledShape('docs/secret')).toEqual({ anchored: true, source: '/^docs\\/secret$/' });
        expect(compiledShape('temp?')).toEqual({ anchored: false, source: '/^(?:[^/]*\\/)*temp[^/]$/' });
        expect(compiledShape('[abc].ts')).toEqual({
            anchored: false,
            source: '/^(?:[^/]*\\/)*[abc]\\.ts$/'
        });
        expect(compiledShape('[!ab].ts')).toEqual({
            anchored: false,
            source: '/^(?:[^/]*\\/)*[^ab]\\.ts$/'
        });
        expect(compiledShape('\\#hash')).toEqual({ anchored: false, source: '/^(?:[^/]*\\/)*#hash$/' });
        expect(compiledShape('keep.log')).toEqual({ anchored: false, source: '/^(?:[^/]*\\/)*keep\\.log$/' });
    });

    it('matches a pattern with no slash at every depth', () => {
        const logs = compileGitignorePattern('*.log').source;
        expect(logs.test('c.log')).toBe(true);
        expect(logs.test('a/b/c.log')).toBe(true);
        expect(logs.test('log')).toBe(false);
        expect(logs.test('a/b/c.log.txt')).toBe(false);

        const modules = compileGitignorePattern('node_modules').source;
        expect(modules.test('node_modules')).toBe(true);
        expect(modules.test('packages/app/node_modules')).toBe(true);
        // The pattern names the ENTRY, not its contents: `/**` is what reaches inside a
        // directory, while `isIgnored`'s ancestor loop is what excludes a file under an
        // ignored one. Keeping that difference is what makes `build/` and `build/**`
        // mean different things (see the matcher tests below).
        expect(modules.test('node_modules/pkg/index.js')).toBe(false);
    });

    it('anchors a pattern that contains a slash to the owning directory', () => {
        const docs = compileGitignorePattern('docs/secret');
        expect(docs.anchored).toBe(true);
        expect(docs.source.test('docs/secret')).toBe(true);
        expect(docs.source.test('a/docs/secret')).toBe(false);

        // An interior `**/` means "zero or more directories", so `a/**/b` still matches
        // `a/b` with nothing in between.
        const deep = compileGitignorePattern('a/**/b');
        expect(deep.anchored).toBe(true);
        expect(deep.source.source).toBe('^a\\/(?:[^/]*\\/)*b$');
        expect(deep.source.test('a/b')).toBe(true);
        expect(deep.source.test('a/x/y/b')).toBe(true);
        expect(deep.source.test('a/b/c')).toBe(false);
    });

    it('compiles ** as zero-or-more directories, /** as everything inside, and bare ** as anything', () => {
        const tmp = compileGitignorePattern('**/tmp');
        // The `**/` branch consumes its own '/' (gitignore.ts `compileGitignorePattern`) so a
        // leading `**/` does not anchor; the result is the any-depth prefix twice.
        expect(tmp.anchored).toBe(false);
        expect(tmp.source.source).toBe('^(?:[^/]*\\/)*(?:[^/]*\\/)*tmp$');
        expect(tmp.source.test('tmp')).toBe(true);
        expect(tmp.source.test('a/b/tmp')).toBe(true);
        expect(tmp.source.test('atmp')).toBe(false);

        const inside = compileGitignorePattern('dist/**');
        expect(inside.anchored).toBe(true);
        expect(inside.source.source).toBe('^dist\\/.*$');
        // `dist` itself is NOT matched by `dist/**` — only what is inside it.
        expect(inside.source.test('dist')).toBe(false);
        expect(inside.source.test('dist/app.js')).toBe(true);
        expect(inside.source.test('dist/a/b.min.js')).toBe(true);

        // A run of stars collapses, so a malformed pattern compiles instead of throwing.
        expect(compileGitignorePattern('**').source.source).toBe('^(?:[^/]*\\/)*.*$');
        expect(compileGitignorePattern('x**y').source.source).toBe('^(?:[^/]*\\/)*x.*y$');
    });

    it('treats ? and a character class as one character inside one segment', () => {
        const temp = compileGitignorePattern('temp?').source;
        expect(temp.test('temp1')).toBe(true);
        expect(temp.test('temps')).toBe(true);
        expect(temp.test('temp12')).toBe(false);
        expect(temp.test('temp')).toBe(false);
        // `?` compiles to `[^/]`, so it can never stand for the separator.
        expect(temp.test('temp/')).toBe(false);

        const classes = compileGitignorePattern('[abc].ts').source;
        expect(classes.test('a.ts')).toBe(true);
        expect(classes.test('c.ts')).toBe(true);
        expect(classes.test('d.ts')).toBe(false);

        const negated = compileGitignorePattern('[!ab].ts').source;
        expect(negated.test('c.ts')).toBe(true);
        expect(negated.test('a.ts')).toBe(false);
        expect(negated.test('b.ts')).toBe(false);
    });

    it('keeps a single * inside one path segment', () => {
        // DOCUMENTED CONTRACT (gitignore.ts "MATCHING RULES", and gitignore(5)): `*` is "any run
        // of characters inside ONE path segment". The expected source and verdicts below
        // follow that sentence, not the current output.
        //
        // RED against gitignore.ts `compileGitignorePattern`, where a single-star run falls into the
        // trailing-`**` branch and emits `.*`: the real source is `^src\/.*\.ts$`, which
        // matches `src/nested/a.ts`. git does not ignore that path for `src/*.ts`.
        const compiled = compileGitignorePattern('src/*.ts');
        expect(compiled.anchored).toBe(true);
        expect(compiled.source.source).toBe('^src\\/[^/]*\\.ts$');
        expect(compiled.source.test('src/a.ts')).toBe(true);
        expect(compiled.source.test('src/nested/a.ts')).toBe(false);
    });

    it('escapes backslash-prefixed characters and keeps an unterminated [ literal', () => {
        // `\#` stays a literal name character, and so does `\!`: stripping the markers is
        // the parser's job, so a compiled body that still carries one treats it literally.
        expect(compileGitignorePattern('\\#hash').source.test('#hash')).toBe(true);
        expect(compileGitignorePattern('\\#hash').source.test('a/#hash')).toBe(true);
        expect(compiledShape('!keep.log')).toEqual({
            anchored: false,
            source: '/^(?:[^/]*\\/)*!keep\\.log$/'
        });

        // An unterminated class is the literal '[', matching ./glob.ts: a typo costs
        // matches, never an exception.
        const broken = compileGitignorePattern('[abc');
        expect(broken.anchored).toBe(false);
        expect(broken.source.source).toBe('^(?:[^/]*\\/)*\\[abc$');
        expect(broken.source.test('[abc')).toBe(true);
        expect(broken.source.test('abc')).toBe(false);
    });

    it('compiles an unstripped trailing or leading slash into the pattern', () => {
        // Why the parser strips both markers before compiling: kept in the body, a
        // trailing '/' anchors AND requires the separator, and a leading '/' becomes
        // `^/Temp$`, which can never match the root-relative path 'Temp'.
        expect(compiledShape('build/')).toEqual({ anchored: true, source: '/^build\\/$/' });
        expect(compiledShape('src/')).toEqual({ anchored: true, source: '/^src\\/$/' });
        expect(compiledShape('/secret')).toEqual({ anchored: true, source: '/^\\/secret$/' });
        expect(compiledShape('/Temp')).toEqual({ anchored: true, source: '/^\\/Temp$/' });
        expect(compileGitignorePattern('/Temp').source.test('Temp')).toBe(false);
    });
});

describe('gitignore parsing', () => {
    it('skips comments and blank lines and drops insignificant trailing spaces', () => {
        expect(ruleShapes('# lead\n\n   \n#no-rule\n')).toEqual([]);

        // Only a LEADING '#' starts a comment, and git strips no trailing comment either,
        // so `keep#notacomment` is one literal name.
        expect(ruleShapes('keep#notacomment')).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*keep#notacomment$/'
            }
        ]);

        // 'build/   ' loses the spaces first, so the '/' is still the trailing marker and
        // a trailing '/' does NOT anchor.
        expect(ruleShapes('build/   ')).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: true,
                anchored: false,
                source: '/^(?:[^/]*\\/)*build$/'
            }
        ]);
    });

    it('keeps a pattern that ends in an escaped space', () => {
        // 'tmp\   ' gives up the two unescaped spaces and keeps the escaped one, because
        // a trailing '\ ' is part of the name.
        expect(ruleShapes('tmp\\   \n')).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*tmp $/'
            }
        ]);
        expect(ruleShapes('tmp   \n')).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*tmp$/'
            }
        ]);
    });

    it('treats an escaped leading marker as a literal name instead of a rule flag', () => {
        expect(ruleShapes('\\#literal\n\\!important\n')).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*#literal$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*!important$/'
            }
        ]);
    });

    it('drops a lone ! or / that is not a pattern', () => {
        expect(ruleShapes('!\n/\n')).toEqual([]);
        expect(ruleShapes('!   \n/  \n')).toEqual([]);
    });

    it('strips the ! and / markers and records them as flags', () => {
        expect(ruleShapes('build/\n/Temp/\n!/Temp/keep.ts\ndist/**\n')).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: true,
                anchored: false,
                source: '/^(?:[^/]*\\/)*build$/'
            },
            {
                // The leading '/' sets the anchored FLAG but leaves the body, so this
                // source is identical to the unanchored `Temp` above.
                base: '',
                negation: false,
                directoryOnly: true,
                anchored: true,
                source: '/^(?:[^/]*\\/)*Temp$/'
            },
            {
                base: '',
                negation: true,
                directoryOnly: false,
                anchored: true,
                source: '/^Temp\\/keep\\.ts$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: true,
                source: '/^dist\\/.*$/'
            }
        ]);
    });

    it('parses one document into the exact rule list', () => {
        const document = [
            '# root ignore file',
            '',
            '   ',
            'build/   ',
            '!/Temp/keep.ts',
            '/Temp/',
            '\\#literal',
            'dist/**',
            'keep\\ ',
            'temp?',
            '[!ab].ts',
            '**/tmp'
        ].join('\n');

        // Three of the twelve lines carry no rule (a comment, an empty line, a
        // spaces-only line), and the order of the rest is the order of the file.
        expect(ruleShapes(document)).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: true,
                anchored: false,
                source: '/^(?:[^/]*\\/)*build$/'
            },
            {
                base: '',
                negation: true,
                directoryOnly: false,
                anchored: true,
                source: '/^Temp\\/keep\\.ts$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: true,
                anchored: true,
                source: '/^(?:[^/]*\\/)*Temp$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*#literal$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: true,
                source: '/^dist\\/.*$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*keep $/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*temp[^/]$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*[^ab]\\.ts$/'
            },
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*(?:[^/]*\\/)*tmp$/'
            }
        ]);
    });

    it('accepts CRLF line endings', () => {
        // A Windows-checked-out .gitignore must not leave a '\r' inside the pattern.
        expect(ruleShapes('a\r\n!b\r\n')).toEqual([
            {
                base: '',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*a$/'
            },
            {
                base: '',
                negation: true,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*b$/'
            }
        ]);
    });

    it('scopes every rule of a document to the directory that owns it', () => {
        expect(ruleShapes('/Temp/\ntmp?\n', 'packages/app')).toEqual([
            {
                base: 'packages/app',
                negation: false,
                directoryOnly: true,
                anchored: true,
                source: '/^(?:[^/]*\\/)*Temp$/'
            },
            {
                base: 'packages/app',
                negation: false,
                directoryOnly: false,
                anchored: false,
                source: '/^(?:[^/]*\\/)*tmp[^/]$/'
            }
        ]);
    });
});

describe('gitignore matcher', () => {
    it('has no rules and no load attempts before anything is read', () => {
        const matcher = createGitignoreMatcher();
        expect(matcher.stats()).toEqual({ files: 0, directories: 0, truncated: false });
        expect(matcher.isIgnored('dist/app.js', false)).toBe(false);
        expect(matcher.isIgnored('dist', true)).toBe(false);
    });

    it('excludes a directory and, through that ancestor level, everything inside it', async () => {
        const matcher = await loadMatcher([['', 'dist/\n']]);

        expect(matcher.isIgnored('dist', true)).toBe(true);
        // A directory-only rule cannot match a FILE of the same name...
        expect(matcher.isIgnored('dist', false)).toBe(false);
        // ...but `dist/app.js` is excluded through the `dist` level, which is a directory
        // whatever the caller asked about.
        expect(matcher.isIgnored('dist/app.js', false)).toBe(true);
        expect(matcher.isIgnored('dist/a/b.min.js', false)).toBe(true);
        expect(matcher.isIgnored('a/dist', true)).toBe(true);
        expect(matcher.isIgnored('a/dist/x.js', false)).toBe(true);
        // Only a whole segment counts.
        expect(matcher.isIgnored('adist', true)).toBe(false);
        expect(matcher.isIgnored('packages/adist/x.js', false)).toBe(false);
        expect(matcher.stats()).toEqual({ files: 1, directories: 1, truncated: false });
    });

    it('does not match the directory itself for a /** rule, only what is inside it', async () => {
        const matcher = await loadMatcher([['', 'build/**\n']]);

        // `build/**` needs a '/' plus something after it, so the directory itself stays
        // visible until a child is listed.
        expect(matcher.isIgnored('build', true)).toBe(false);
        expect(matcher.isIgnored('build', false)).toBe(false);
        expect(matcher.isIgnored('build/index.js', false)).toBe(true);
        expect(matcher.isIgnored('build/a/b.js', false)).toBe(true);
        expect(matcher.isIgnored('rebuild/index.js', false)).toBe(false);
        // `build/**` carries a '/' in the body, so it is ANCHORED to the owning directory
        // and does not reach a nested copy of the name (an unanchored `build/` does,
        // because the any-depth prefix is added instead).
        expect(matcher.isIgnored('packages/app/build/a.js', false)).toBe(false);
    });

    it('excludes a file under a leading-slash directory rule (the /Temp/ regression)', async () => {
        const matcher = await loadMatcher([['', '/Temp/\n']]);

        expect(matcher.isIgnored('Temp', true)).toBe(true);
        // THE regression: a leading '/' left in the body compiles `^/Temp$` and this
        // verdict flips to false, silently re-adding every scratch file.
        expect(matcher.isIgnored('Temp/points.mts', false)).toBe(true);
        expect(matcher.isIgnored('Temp/nested/points.mts', false)).toBe(true);
        expect(matcher.isIgnored('Temp', false)).toBe(false);
        expect(matcher.isIgnored('other/points.mts', false)).toBe(false);
        // Observable consequence of stripping the slash: the body carries no '/' anymore,
        // so the any-depth prefix survives and an interior `Temp` segment matches too.
        expect(matcher.isIgnored('nested/Temp/x.ts', false)).toBe(true);
    });

    it('matches an unanchored directory rule at any depth', async () => {
        const matcher = await loadMatcher([['', 'foo/\n']]);

        expect(matcher.isIgnored('foo', true)).toBe(true);
        expect(matcher.isIgnored('foo', false)).toBe(false);
        expect(matcher.isIgnored('x/foo', true)).toBe(true);
        // The final segment is a file, so the directory-only rule stops at `x`.
        expect(matcher.isIgnored('x/foo', false)).toBe(false);
        expect(matcher.isIgnored('x/foo/y.txt', false)).toBe(true);
        expect(matcher.isIgnored('foobar', true)).toBe(false);
    });

    it('lets a later negation re-include a path an earlier rule excluded', async () => {
        const matcher = await loadMatcher([['', '*.log\n!keep.log\n']]);

        expect(matcher.isIgnored('a/keep.log', false)).toBe(false);
        expect(matcher.isIgnored('keep.log', false)).toBe(false);
        expect(matcher.isIgnored('a/other.log', false)).toBe(true);
        // Neither rule names this path at all.
        expect(matcher.isIgnored('a/keep.log.txt', false)).toBe(false);
    });

    it('applies rules only inside the directory that owns the .gitignore', async () => {
        const matcher = await loadMatcher([['src', '*.tmp\n']]);

        expect(matcher.isIgnored('src/x.tmp', false)).toBe(true);
        expect(matcher.isIgnored('src/deep/x.tmp', false)).toBe(true);
        // `src` is not a prefix of these, so the rule never reaches them.
        expect(matcher.isIgnored('packages/other/x.tmp', false)).toBe(false);
        expect(matcher.isIgnored('src2/x.tmp', false)).toBe(false);
        // A base is not inside itself: the owning directory is judged by its PARENT's
        // rules, never by its own file.
        expect(matcher.isIgnored('src', true)).toBe(false);
        expect(matcher.stats()).toEqual({ files: 1, directories: 1, truncated: false });
    });

    it('lets a deeper .gitignore have the final say in its own subtree', async () => {
        // Load order is walk order: the root file first, `sub/`'s file last, so the
        // inner negation wins for paths under `sub` only.
        const matcher = await loadMatcher([
            ['', 'cache/\n'],
            ['sub', '!cache/\n']
        ]);

        expect(matcher.isIgnored('sub/cache', true)).toBe(false);
        expect(matcher.isIgnored('sub/cache/file.txt', false)).toBe(false);
        expect(matcher.isIgnored('sub/deep/cache', true)).toBe(false);
        expect(matcher.isIgnored('sub/deep/cache/x.txt', false)).toBe(false);
        // Outside `sub` the root rule still stands.
        expect(matcher.isIgnored('other/cache', true)).toBe(true);
        expect(matcher.isIgnored('other/cache/file.txt', false)).toBe(true);
        expect(matcher.isIgnored('cache', true)).toBe(true);
        expect(matcher.stats()).toEqual({ files: 2, directories: 2, truncated: false });
    });

    it('never lets one subtree rule reach into a sibling subtree', async () => {
        const matcher = await loadMatcher([
            ['packages/app', 'x.tmp\n'],
            ['packages/web', 'y.tmp\n']
        ]);

        expect(matcher.isIgnored('packages/app/x.tmp', false)).toBe(true);
        expect(matcher.isIgnored('packages/app/deep/logs/x.tmp', false)).toBe(true);
        expect(matcher.isIgnored('packages/web/y.tmp', false)).toBe(true);
        expect(matcher.isIgnored('packages/web/x.tmp', false)).toBe(false);
        expect(matcher.isIgnored('packages/app/y.tmp', false)).toBe(false);
        // The shared prefix `packages` is shorter than either base, so neither applies.
        expect(matcher.isIgnored('packages/x.tmp', false)).toBe(false);
        expect(matcher.isIgnored('packages/app', true)).toBe(false);
        expect(matcher.stats()).toEqual({ files: 2, directories: 2, truncated: false });
    });

    it('treats a missing .gitignore as no rules and counts the base once', async () => {
        const caseDirectory = join(workdir, `case-${caseIndex++}`);
        await mkdir(caseDirectory, { recursive: true });

        const matcher = createGitignoreMatcher();
        await matcher.load(caseDirectory, '');
        // Same directory again: `loadedBases` dedupes, so nothing is parsed twice and no
        // second attempt is counted.
        await matcher.load(caseDirectory, '');

        expect(matcher.stats()).toEqual({ files: 1, directories: 1, truncated: false });
        expect(matcher.isIgnored('anything.ts', false)).toBe(false);
        expect(matcher.isIgnored('anything', true)).toBe(false);
    });

    it('does not throw when .gitignore is a directory', async () => {
        const caseDirectory = join(workdir, `case-${caseIndex++}`);
        await mkdir(join(caseDirectory, GITIGNORE_FILE_NAME), { recursive: true });

        const matcher = createGitignoreMatcher();
        await expect(matcher.load(caseDirectory, '')).resolves.toBeUndefined();

        expect(matcher.stats()).toEqual({ files: 1, directories: 1, truncated: false });
        expect(matcher.isIgnored('x', true)).toBe(false);
    });

    it('reads only the exact .gitignore file name', async () => {
        // A sibling file with the same rules in it is a normal search result, not a rule
        // source; the control case proves the rules themselves do apply when the name is
        // right.
        const matcher = await loadMatcher([['', 'ignored-name\n']]);
        expect(matcher.isIgnored('ignored-name', false)).toBe(true);

        const caseDirectory = join(workdir, `case-${caseIndex++}`);
        await writeAt(join(caseDirectory, 'gitignore'), 'ignored-name\n');

        const quiet = createGitignoreMatcher();
        await quiet.load(caseDirectory, '');
        expect(quiet.stats()).toEqual({ files: 1, directories: 1, truncated: false });
        expect(quiet.isIgnored('ignored-name', false)).toBe(false);
    });

    it('reads the first .gitignore for a base and never replaces it with a later one', async () => {
        const caseDirectory = join(workdir, `case-${caseIndex++}`);
        const nested = absoluteFor(caseDirectory, 'nested');
        await writeAt(join(nested, GITIGNORE_FILE_NAME), 'early.tmp\n');

        const matcher = createGitignoreMatcher();
        await matcher.load(nested, 'nested');

        await writeAt(join(nested, GITIGNORE_FILE_NAME), 'late.tmp\n');
        await matcher.load(nested, 'nested');

        expect(matcher.stats()).toEqual({ files: 1, directories: 1, truncated: false });
        expect(matcher.isIgnored('nested/early.tmp', false)).toBe(true);
        expect(matcher.isIgnored('nested/late.tmp', false)).toBe(false);
    });

    it('parses an oversized .gitignore only up to the byte bound and flags truncation', async () => {
        // ASCII keeps Buffer.byteLength equal to the length, so the bound is exact and the
        // padding lets the cut land inside the file: 7 ('before\n') + 64 * 4097 (comment
        // lines, 262208) + 6 ('after\n') = 262221 characters, cut at 262144.
        const commentLine = `${'#'.repeat(63)}\n`;
        const oversized = `before\n${commentLine.repeat(4097)}after\n`;
        expect(oversized.length).toBe(262221);

        const matcher = await loadMatcher([['', oversized]]);

        expect(matcher.stats()).toEqual({ files: 1, directories: 1, truncated: true });
        // The rules before the bound still apply, and the line after it is gone.
        expect(matcher.isIgnored('before', false)).toBe(true);
        expect(matcher.isIgnored('before/deep/x.ts', false)).toBe(true);
        expect(matcher.isIgnored('after', false)).toBe(false);
    });

    it('keeps matching usable when one line fills the whole byte bound', async () => {
        // DOCUMENTED CONTRACT (gitignore.ts `load`): the byte bound is "a bound, not a
        // rejection ... the rules that matter (they come first in practice) still apply".
        // A file with no newline at all is the worst case the bound allows: the slice
        // leaves ONE literal pattern of 262137 characters.
        //
        // RED against the implementation: `new RegExp` accepts that pattern, but V8
        // refuses to EXECUTE it, so the first `rule.source.test(candidate)` inside
        // `isIgnored` throws `SyntaxError: Invalid regular expression: …: Regular
        // expression too large`, and every later verdict of the walk dies with it — the
        // opposite of "costs rules, not the walk" (the MAX_GITIGNORE_LINE_CHARS note in
        // ./gitignore.ts). ./glob.ts `walkFiles` calls `isIgnored` outside its only
        // try/catch, so the whole search fails. Expected below is the documented verdict,
        // not the throw.
        const singleLine = `before\n${'z'.repeat(MAX_GITIGNORE_BYTES + 1)}\nafter\n`;

        const matcher = await loadMatcher([['', singleLine]]);

        // The cap accounting is unaffected: the file was read and truncated as documented.
        expect(matcher.stats()).toEqual({ files: 1, directories: 1, truncated: true });

        // `isIgnored` has to ANSWER. The verdict is captured as a string so a throw shows
        // up as this short diff, instead of a 256 KiB pattern dumped into the report; V8
        // repeats the whole pattern in the message, so only the stable tail is kept.
        const verdictOf = (path: string): string => {
            try {
                return String(matcher.isIgnored(path, false));
            } catch (error) {
                return `${(error as Error).name}: ${(error as Error).message.slice(-28)}`;
            }
        };

        expect(verdictOf('before')).toBe('true');
        expect(verdictOf('after')).toBe('false');
    });

    it('skips the read entirely when the walker says the file is absent', async () => {
        // THE EFFICIENCY FIX. A repo-wide walk used to pay one failed `open` per
        // directory for a file the walker had already seen was not there — hundreds of
        // syscalls, and worse, each one consumed the MAX_GITIGNORE_FILES budget, so a
        // tree with more than 512 DIRECTORIES reported `truncated: true` while parsing
        // only a handful of real files. The cap bounds files parsed, and that is what it
        // now bounds.
        const caseDirectory = join(workdir, `case-${caseIndex++}`);
        await mkdir(caseDirectory, { recursive: true });

        const matcher = createGitignoreMatcher();

        for (let index = 0; index < MAX_GITIGNORE_FILES + 5; index++) {
            // `present: false` is what ./glob.ts passes from its own readdir entries.
            await matcher.load(caseDirectory, `d${index}`, { present: false });
        }

        // cap + 5 directories CHECKED, zero files registered, and the cap never fired —
        // the two counters say exactly that, which is the point of keeping both.
        expect(matcher.stats()).toEqual({
            files: 0,
            directories: MAX_GITIGNORE_FILES + 5,
            truncated: false
        });
        expect(matcher.isIgnored('anything', false)).toBe(false);

        // A directory the walker says DOES have the file still goes through the cap.
        await writeAt(join(caseDirectory, GITIGNORE_FILE_NAME), 'early.tmp\n');
        await matcher.load(caseDirectory, 'real', { present: true });

        // `directories` keeps the 2053 no-file checks and adds this one, while `files`
        // counts only the real parse — the two numbers answering different questions.
        expect(matcher.stats()).toEqual({
            files: 1,
            directories: MAX_GITIGNORE_FILES + 6,
            truncated: false
        });
        expect(matcher.isIgnored('real/early.tmp', false)).toBe(true);
    });

    it('stops loading after MAX_GITIGNORE_FILES attempts and flags truncation', async () => {
        const capRoot = join(workdir, `case-${caseIndex++}`);
        const matcher = createGitignoreMatcher();

        // Only three of the directories need to exist: a load attempt registers its base
        // whether or not the read succeeds, which is what the cap counts.
        const last = MAX_GITIGNORE_FILES - 1;

        await writeAt(join(capRoot, 'd0', GITIGNORE_FILE_NAME), 'early\n');
        await writeAt(join(capRoot, `d${last}`, GITIGNORE_FILE_NAME), 'last\n');
        await writeAt(join(capRoot, `d${last + 1}`, GITIGNORE_FILE_NAME), 'late\n');

        for (let index = 0; index <= MAX_GITIGNORE_FILES + 2; index++) {
            await matcher.load(join(capRoot, `d${index}`), `d${index}`);
        }

        // cap + 3 attempts, `cap` registered (d0..d{cap-1}): the next is the first load
        // the cap drops.
        expect(matcher.stats()).toEqual({
            files: MAX_GITIGNORE_FILES,
            directories: MAX_GITIGNORE_FILES,
            truncated: true
        });
        expect(matcher.isIgnored('d0/early', false)).toBe(true);
        expect(matcher.isIgnored(`d${last}/last`, false)).toBe(true);
        expect(matcher.isIgnored(`d${last + 1}/late`, false)).toBe(false);

        // Re-loading a registered base is a no-op, not another truncation.
        await matcher.load(join(capRoot, 'd0'), 'd0');
        expect(matcher.stats()).toEqual({
            files: MAX_GITIGNORE_FILES,
            directories: MAX_GITIGNORE_FILES,
            truncated: true
        });
    });
});
