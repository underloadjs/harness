// CLI preset default + explicit offline demo (T5).
//
// `index.ts` is executable at import time, so the parser lives in ./options and
// these assertions pin the product decision without booting a process:
//   - no `--preset` selects the LIVE Instruct role (the useful harness), never
//     the scripted fixture and never a silent demo fallback;
//   - `--preset demo` still selects the offline fixture, which constructs and
//     registers its tools with empty provider settings.

import { describe, expect, it } from 'vitest';
import { findPreset } from '../harnesses';
import { DEFAULT_CLI_PRESET, parseCliOptions } from './options';

describe('CLI preset selection', () => {
    it('defaults to the live Instruct role instead of the demo', () => {
        const parsed = parseCliOptions([]);

        expect(DEFAULT_CLI_PRESET).toBe('instruct');
        expect(parsed.values.preset).toBe('instruct');
        expect(parsed.positionals).toEqual([]);

        const preset = findPreset(parsed.values.preset as string);

        expect(preset).toBeDefined();
        expect({
            name: preset!.name,
            title: preset!.title,
            primary: preset!.primary,
            requiresEndpoint: preset!.requiresEndpoint,
            subagents: preset!.subagents
        }).toEqual({
            name: 'instruct',
            title: 'Instruct',
            primary: 'instruct',
            requiresEndpoint: true,
            subagents: ['research', 'workspace', 'reviewer', 'planner', 'summarizer']
        });
    });

    it('keeps demo as an explicit, endpoint-free preset', () => {
        const parsed = parseCliOptions(['--preset', 'demo', 'what time is it']);
        const preset = findPreset(parsed.values.preset as string);

        expect(parsed.values.preset).toBe('demo');
        expect(parsed.positionals).toEqual(['what time is it']);
        expect(preset).toBeDefined();
        expect({
            name: preset!.name,
            requiresEndpoint: preset!.requiresEndpoint,
            primary: preset!.primary
        }).toEqual({ name: 'demo', requiresEndpoint: false, primary: 'demo' });

        // No provider settings at all: the scripted demo must still construct and
        // expose its offline toolset (it is explicitly chosen, never a fallback).
        const offline = preset!.create({ baseURL: '', apiKey: '', model: '' }, () => {});

        expect(Object.keys(offline.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            // N6: forks are enabled by default, so threadFork is registered even
            // in the scripted fixture (which has no owner interaction).
            'threadFork',
            'toolCancel',
            'timeNow'
        ]);
        expect(offline.tools.agentDelegate).toBeUndefined();
    });

    it('still accepts the short -p form and leaves other options at their defaults', () => {
        const parsed = parseCliOptions(['-p', 'reviewer', 'review this']);

        expect(parsed.values).toMatchObject({
            preset: 'reviewer',
            list: false,
            tools: false,
            json: false,
            serve: false,
            help: false
        });
        expect(parsed.positionals).toEqual(['review this']);
    });
});
