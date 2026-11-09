// The frontend extension subsystem (T5/R1): the plug-and-play seam under the panel
// pipeline.
//
// WHAT THIS FOLDER IS
// -------------------
// The shell used to know one way to draw a panel: sanitize the data, build the card,
// put it in the host. Everything a plugin wants to do — draw a payload the generic
// block renderer cannot express, or keep a live, session-scoped view on the scratch
// board — used to mean editing `main.ts`. This folder is the seam that replaced that:
// two registries and the engine that reconciles them against the hosts the shell
// already owns.
//
//     panel-kinds.ts    one renderer per typed panel kind, with a data-only fallback
//     shell-panels.ts   persistent, session-scoped panels (tasks, records, ...)
//     context.ts        the disposal-scoped capabilities a mounted panel receives
//     runtime.ts        mount/unmount + session switching, painted by the shell
//
// THE LIVE PAIRS (T6) — the first panels that stay mounted for a whole conversation:
//
//     records-client.ts the record store's realtime state (wake + delta, no polling)
//     records-wake.ts   ONE session registration, fanned out to every live panel
//     records-dom.ts    the shared UX layer: live region, follow, FLIP, stamps
//     records-panels.ts  `harness.tasks` + `harness.records`, registered by main.ts
//
// IMPORT SAFETY (the rule ./index.ts and src/structure.test.ts pin): nothing here
// creates an element, reads the DOM or subscribes to anything at module scope. The
// two registries are plain Maps, so a host may import and register from anywhere,
// including Node.
//
// THE EMPTY-REGISTRY RULE: with no kind and no shell panel registered, the shell
// paints exactly the DOM it painted before this seam existed. `main.ts` owns the
// hosts, the paint call-sites and the session pointer; this subsystem never reaches
// back into the shell.
//
// Cross-references:
//   - ../ui/panels.ts  — slots, sanitizer, hosts (the display side of the seam)
//   - ../main.ts       — `paintPanels`, and where the runtime is created
//   - ../index.ts      — the published client barrel (`@underload/harness/frontend`)

export * from './panel-kinds';
export * from './shell-panels';
export * from './context';
export * from './runtime';
export * from './records-client';
export * from './records-dom';
export * from './records-wake';
export * from './records-panels';
