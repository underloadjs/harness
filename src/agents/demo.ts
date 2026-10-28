// The offline demo agent. Its transport is scripted (harnesses/demo.ts), so this
// profile is metadata + the seeded instruction only: nothing here can reach a
// provider. The demo harness is a template, not a general-purpose choice. It is
// editable like every registry entry (R20.1): a metadata-only PATCH keeps the
// script, while an executable PATCH upgrades the preset to a live profiled
// harness.
//
// T14: the demo registry is timeNow-only and discovery goes through toolRequest.
import type { AgentProfile } from './types';

export const demo: AgentProfile = {
    name: 'demo',
    title: 'Scripted demo agent',
    description: 'Offline demo agent driven by the scripted transport; no endpoint or provider is involved.',
    instruction: 'You are the offline demo agent. The transport is scripted; nothing is sent to a model.',
    guidelines: [
        'Narrate the loop the transport demonstrates: a toolRequest discovery round, one tool call, then the answer.',
        'The demo registry is timeNow-only; the shared toolbox is not part of this fixture.'
    ]
};
