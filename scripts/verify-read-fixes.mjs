// Ad-hoc verification of the read/write/edit changes against the stress-report scenarios.
// Run: npx vite-node scripts/verify-read-fixes.mjs
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';

const C = 'D:/Projects/typescript/noobscript/.verify/c';
rmSync(C, { recursive: true, force: true });
mkdirSync(C, { recursive: true });

let L = [];
for (let i = 1; i <= 200000; i++) L.push(`line ${i} const x${i} = fn(a,b,c); // comment ${i}`);
writeFileSync(`${C}/big.txt`, L.join('\n') + '\n');
writeFileSync(`${C}/a1.txt`, 'A'.repeat(40000) + '\n');
writeFileSync(`${C}/base.txt`, 'line one\nLINE TWO EDITED\nline three\n');
writeFileSync(`${C}/nul.bin`, Buffer.concat([Buffer.from('hello'), Buffer.from([0]), Buffer.from('world')]));
writeFileSync(`${C}/uni.txt`, 'emoji \u{1F389} family\ncjk \u4f60\u597d\n');

const { read, FILE_READ_DEFAULT_MAX_LINES, FILE_READ_WIRE_BUDGET } = await import('../src/tools/files/read.tool.ts');
const { edit } = await import('../src/tools/files/edit.tool.ts');
const { write } = await import('../src/tools/files/write.tool.ts');
const { MODEL_TOOL_RESULT_BUDGET_BYTES, boundToolResult } = await import('../src/core/result-budget.ts');

let failures = 0;
const show = (label, ok, detail) => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};

// ---- D1: a full-budget read must survive the harness envelope intact.
{
    const r = await read([{ path: `${C}/big.txt`, maxLines: 5000 }]);
    const serialized = JSON.stringify(r);
    const bounded = boundToolResult(serialized);

    show(
        'D1  full-budget read survives the harness envelope',
        bounded.truncated === false,
        `wireBytes=${r.wireBytes} accurate=${r.wireBytes === Buffer.byteLength(serialized, 'utf8')} serialized=${Buffer.byteLength(serialized, 'utf8')} cap=${MODEL_TOOL_RESULT_BUDGET_BYTES}`
    );

    const e = r.files[0];
    show(
        'D1  continuation fields survive',
        e.truncated === true && e.nextLine !== null && e.nextByte !== null,
        `nextLine=${e.nextLine} nextColumn=${e.nextColumn} nextByte=${e.nextByte}`
    );
}

// ---- D2: demand-based allocation.
{
    const paths = [{ path: `${C}/a1.txt`, maxLines: 1 }, ...Array.from({ length: 99 }, () => `${C}/base.txt`)];
    const r = await read(paths);
    show(
        'D2  large file not starved by 99 tiny neighbours',
        r.files[0].bytes === 40001 && r.files[0].truncated === false,
        `bytes=${r.files[0].bytes} truncated=${r.files[0].truncated} (was 655 before)`
    );

    const mixed = await read([{ path: `${C}/a1.txt`, maxLines: 1 }, `${C}/base.txt`]);
    show('D2  surplus from a small file is reallocated', mixed.files[0].bytes === 40001, `bytes=${mixed.files[0].bytes}`);
}

// ---- D3/D5: binary and directory are per-entry, not batch-fatal.
{
    const r = await read([`${C}/nul.bin`, `${C}/uni.txt`]);
    show(
        'D3  binary no longer kills the batch',
        r.files[0].error?.code === 'EBINARY' && r.files[1].content.includes('emoji'),
        `entry0=${r.files[0].error?.code} entry1bytes=${r.files[1].bytes} skipped=${r.skipped}`
    );

    const d = await read([C, `${C}/uni.txt`]);
    show(
        'D3  directory no longer kills the batch',
        d.files[0].error?.code === 'EISDIR' && d.files[1].bytes > 0,
        `entry0=${d.files[0].error?.code} entry1bytes=${d.files[1].bytes}`
    );
}

// ---- Efficiency: startByte seeking must equal the line-based window.
{
    const first = await read([{ path: `${C}/big.txt`, maxLines: FILE_READ_DEFAULT_MAX_LINES }]);

    const t1 = Date.now();
    const seeked = await read([
        {
            path: `${C}/big.txt`,
            startByte: first.files[0].nextByte,
            startLine: first.files[0].nextLine,
            maxLines: FILE_READ_DEFAULT_MAX_LINES
        }
    ]);
    const seekMs = Date.now() - t1;

    // The documented equivalent of `startByte = nextByte` is
    // `{ startLine: nextLine, startColumn: nextColumn }`, so that is what the seek must
    // reproduce. The check used to compare against `startLine` ALONE, which was only
    // ever equal because the old 5000-line default cut exactly at a line boundary
    // (nextColumn = 0); with no default cap the budget binds mid-line, and a window that
    // starts at the beginning of nextLine is a different — also correct — answer. Both
    // claims are checked now: the mid-line equivalence, and line-boundary equality where
    // the offset is derived from the fixture rather than from a reported nextByte.
    const t2 = Date.now();
    const lineBased = await read([
        {
            path: `${C}/big.txt`,
            startLine: first.files[0].nextLine,
            startColumn: first.files[0].nextColumn ?? 0,
            maxLines: FILE_READ_DEFAULT_MAX_LINES
        }
    ]);
    const lineMs = Date.now() - t2;

    show(
        'seek  startByte reproduces the line+column window exactly',
        seeked.files[0].content === lineBased.files[0].content && seeked.files[0].nextByte === lineBased.files[0].nextByte,
        `seek=${seekMs}ms vs rescan=${lineMs}ms (cut at line ${first.files[0].nextLine}, column ${first.files[0].nextColumn})`
    );

    const boundaryLine = 100_000;
    const boundaryByte = Buffer.byteLength(L.slice(0, boundaryLine - 1).map((s) => s + '\n').join(''), 'utf8');
    const atBoundarySeek = await read([{ path: `${C}/big.txt`, startByte: boundaryByte, maxLines: 50 }]);
    const atBoundaryLine = await read([{ path: `${C}/big.txt`, startLine: boundaryLine, maxLines: 50 }]);
    show(
        'seek  at a line boundary, startByte equals the counted window',
        atBoundarySeek.files[0].content === atBoundaryLine.files[0].content &&
            atBoundarySeek.files[0].startLine === atBoundaryLine.files[0].startLine &&
            atBoundarySeek.files[0].nextByte === atBoundaryLine.files[0].nextByte,
        `line ${boundaryLine}`
    );
}

// ---- Utilization: a DEFAULT read must fill the envelope it is delivered in.
{
    const first = await read([`${C}/big.txt`]);
    const util = first.wireBytes / FILE_READ_WIRE_BUDGET;

    show(
        `util  default read (maxLines=${FILE_READ_DEFAULT_MAX_LINES}) fills the budget`,
        util > 0.8,
        `${(util * 100).toFixed(1)}% of ${FILE_READ_WIRE_BUDGET}; lines 1-${first.files[0].endLine} (was 200 lines / 14.2% of 64 KiB, then 1200 lines / 22.7%)`
    );
}

// ---- D4: concurrent edits of one file must not silently lose an update.
{
    const p = `${C}/race.txt`;
    writeFileSync(p, 'VERSION-0\n');

    const results = await Promise.allSettled([
        edit([{ path: p, oldString: 'VERSION-0', newString: 'VERSION-A' }]),
        edit([{ path: p, oldString: 'VERSION-0', newString: 'VERSION-B' }]),
        edit([{ path: p, oldString: 'VERSION-0', newString: 'VERSION-C' }])
    ]);

    const applied = results.filter((outcome) => outcome.status === 'fulfilled').length;
    const disk = readFileSync(p, 'utf8').trim();

    show(
        'D4  concurrent edits lose no update',
        applied === 1 && ['VERSION-A', 'VERSION-B', 'VERSION-C'].includes(disk),
        `applied=${applied}/3 disk=${disk} (before the per-file lock: applied=3/3, disk=VERSION-C)`
    );
}

// ---- D8: edit on a missing file must name the remedy, not the errno.
{
    let message = '';
    try {
        await edit([{ path: `${C}/definitely-absent.txt`, oldString: 'a', newString: 'b' }]);
    } catch (error) {
        message = error.message;
    }

    show(
        'D8  edit missing-file message names write',
        /edit could not find/.test(message) && /use write to create one/.test(message),
        JSON.stringify(message.slice(0, 140))
    );
}

// ---- Paging a huge line with startByte reconstructs the file exactly.
{
    const huge = `${C}/huge.txt`;
    writeFileSync(huge, 'x'.repeat(400000) + '\nTAIL\n');

    let collected = '';
    let next = { truncated: true, nextByte: 0, nextLine: 1 };
    let pages = 0;

    while (next.truncated && pages < 20) {
        const page = await read([{ path: huge, startByte: next.nextByte ?? 0, startLine: next.nextLine ?? 1 }]);
        next = page.files[0];
        collected += next.content;
        pages += 1;
    }

    show('page  startByte paging reconstructs the file byte-for-byte', collected === 'x'.repeat(400000) + '\nTAIL\n', `pages=${pages} bytes=${collected.length}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
rmSync('D:/Projects/typescript/noobscript/.verify', { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
