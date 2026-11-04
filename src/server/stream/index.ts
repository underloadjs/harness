// The realtime half of the harness server: one update stream, mounted at `/v1/harness/stream`.
//
// Layout, and the one rule each file owns:
//   - ./protocol.ts   — the closed vocabularies, per-scope tables, the opaque cursor codec, and the
//                       client-frame schema check (precedence steps 1-2);
//   - ./broker.ts     — the process-lifetime state: epoch, addressed revision counters,
//                       subscriptions, per-subscription sequences/cursors, and the replay window;
//   - ./transport.ts  — RFC 6455 framing and the `101` handshake, with no knowledge of the harness;
//   - ./connection.ts — one peer's conversation: welcome, hello/subscribe/ack/ping/bye, heartbeat,
//                       rate limiting, and the drop-oldest backpressure rule;
//   - ./mount.ts      — attaching that to a Node `http.Server` (standalone) or to the
//                       `@underload/service` gateway's upgrade hook, plus the store/registry bridge.
//
// WHAT THIS MODULE DOES NOT DO. It never reads a session tree, never emits a snapshot, and never
// mutates anything: every state change is a REST write, and the stream's contract is "something
// changed, here is the bounded delta, and here is the REST read that restores you". `store.watchView`
// is deliberately unused, because it opens by emitting a whole compiled view.
//
// Publish path for the REST/store owner: `runtime.stream.broker.publish(event)` (or
// `runtime.streamBridge`, which needs no import of this module). See ./mount.ts for the three
// optional host callbacks (`exists` / `baseline` / `link`) that make `unknown_resource`,
// `subscription_state.revisions`, and `resync_required.resources` answer from real data.
//
// Cross-references:
//   - ../handler.ts ../start.ts — the standalone listener's upgrade attachment
//   - ../service.ts ../endpoint/harness/service-route-stream.ts — the gateway-mounted attachment
//   - ../../shared/harness-stream.ts — the generated frame vocabulary this module implements

export * from './protocol';
export * from './broker';
export * from './transport';
export * from './connection';
export * from './mount';
