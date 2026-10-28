# Planner context — design

## Intent

The dialogue planner gets a context prepared for the current request, not the whole conversation.

Today `DialogueSession.turn()` sends `structuredClone(this.conversation)` (up to
`DIALOGUE_HISTORY_LIMIT` = 200 messages) to the planner on every call, with the `[plan]` and
environment notes prepended to the last message. Every earlier request, planner reply, `[task events]`
and `[actions]` note and every final document travels again on each planner LLM call, and a turn makes
several calls. Measured on a hub deployment: after one impact-analysis request (final document about
7 KB), the first turn of an unrelated second request cost 541k planner input tokens; the second request
cost 920k planner tokens for 87k of worker work. Planner tokens are the most expensive of the session.

The same history blocks iterative work on a result ("fix section 2"): the planner would read the whole
previous document to delegate a small change, and a worker gets it only through `history: all` (the last
20 raw messages).

Principle: the planner sees the current request in full, earlier requests as a short digest, and fetches
earlier content on demand; workers get earlier results by reference.

## Terms

- **Planner call**: one `planner.process()` invocation (a turn makes one or more: corrections).
- **Session turn**: one run of `turn()` for a user input or an event batch.
- **Request**: a logical unit of work owned by the session's single plan. The decision is made when a
  queued user input is consumed by `turn()` (not when `send()` enqueues it), before the turn changes the
  plan. Two ways close a request and open the next:
  - **Automatic (simple case only).** The input opens a new request when all hold: the plan is absent or
    `done` (status, not inferred from steps); the plan status is not `waiting_user`; the request's latest
    session turn ended with a successful planner reply (`lastTurnOk`, persisted on the record; a failed
    turn keeps the request open so a retry joins; legacy requests count as ok); no task of the session
    is queued or running; and no task event is queued.
  - **Explicit (planner decides).** Otherwise the input joins the open request. When the planner sees
    that the input starts unrelated work, it calls the planner tool `new_request()`. Eligibility is
    enforced by the session (tool error otherwise): only in a user turn; only in the first planner call
    of the turn; only as the first tool call of any kind in that call (so no status read, plan read or
    control action precedes it); at most once per turn; never when the plan status was `waiting_user` at
    turn entry (captured before `turn()` reactivates the plan; an answer stays in its request). Text the
    planner streamed before the call is discarded from the turn's reply buffer, and the wait-mode
    status-read state (`lastReadVersion`) is reset, so the new request's turn starts clean. Effect, immediately within the call: the open request closes
    (snapshot, `closedAt`, the current plan archived as an immutable `closedPlan`), the consumed user
    input moves from the old transcript to the new request as its first message, and the plan resets to
    empty. Because the call is the turn's first control action, no actions, `started` flag, correction
    count, partial text or status-read state of the old request exist yet; the whole turn (all its
    planner calls, replies, `[actions]` and archive entries) belongs to the new request. Turn-level usage
    is unaffected. Because the plan is reset at the boundary, a new request never inherits
    removal/consent restrictions of the old plan; consent checks within a request are unchanged.
  - **Old tasks.** Running tasks of a closed request keep running. The session records task-to-request
    ownership at delegation (persisted). Their events are reported to the planner labelled with their
    request (`[task events] from r2: …`) and never change the current plan or a reused step id; they
    update only the task board record and the closed request's counters, not its archived plan.
  Event turns always belong to the open request. The request id chosen for a turn stays fixed for all
  its planner calls, its archive entries and its save (with `new_request()` it is the new request from
  the start of the turn). This keeps today's single-plan model: one plan, one open request.

## Goals

1. **Prepared context per planner call.** Every planner call (including corrective calls) is built by a
   context builder from:
   - `[session]`: a digest of closed earlier requests (see 2);
   - the open request's transcript in chronological order: its first user input, later user inputs,
     event and `[restart]` / `[check]` triggers, the planner's replies (including intermediate correction
     replies) and `[actions]` notes, as a bounded projection of the request's stored transcript (see
     Session);
   - the notes prepended today to the last message: the existing bounded `[plan]` view (full steps stay
     available through `get_plan`), worker budget notes, `[environment]`.
   Messages of closed requests are not sent.
2. **Digest of closed requests.** When a request closes (the next request opens), the session snapshots
   `{ id, openedAt, closedAt, text (first user input), plan: { status, steps, done, failed, skipped },
   replies (final PlannerMessage ids, newest last) }`. The `[session]` note renders the last 20 closed
   requests, one line each, newest last:
   `r3 · plan done · 5/5 steps · "Разработай документ согласно правилам…" · replies 1f2c…, 9ab0…`
   (text cut to 200 characters, at most 3 reply ids, the last ones). Status words come from the plan
   only; there is no separate outcome taxonomy.
3. **On-demand reads.**
   - `get_message({ id, offset?, limit? })` returns a final planner message of this session (opaque
     existing `PlannerMessage.id`), paged by characters (default limit 8 000, max 32 000).
   - `get_request({ id, offset?, limit? })` returns bounded metadata of a request (open or closed):
     `{ id, openedAt, closedAt?, plan?, replies (last 20 ids), text (first 2 000 characters of the first
     input) }` plus one page of its stored transcript rendered as `role: content` blocks:
     `{ offset, total, next?, text }`, paged by characters over that stable rendering with the same
     limits (`next` absent at the end). The full record is never returned at once.
   Both are tool errors for unknown or expired ids, are not status reads for wait mode, and are available
   in both modes.
4. **Results by reference.** `delegate_task` gains `inputs?: Array<{ id: string; offset?: number;
   limit?: number }>` (message ids). Each input is resolved into the worker context as
   `[input <id> <offset>-<end> of <total>]\n<text>` after the explicit `context`. Bounds: default limit
   40 000 characters per input, 120 000 total including labels; at most 5 inputs. If a bound cuts an
   input, `delegate_task` fails with a tool error naming the input, its total and the allowed size, so the
   planner passes a range instead of delegating silently truncated content. Duplicate ids are a tool
   error. `history` keeps its current semantics (raw conversation, `all` = last 20, `last-turn`).
5. **Iterative work.** A follow-up such as "add a section on X to the document" while no request is open
   opens a new request; the planner sees the digest with the document's reply id and delegates the change
   with `inputs: [{ id }]`, returning the updated document. A new search happens only if the change needs
   facts that are not in the referenced message. Worker outputs on the task board stay cut to 4 000
   characters; what a follow-up can reference is the planner's final messages.
6. **Compatibility.** `DialogueSessionOptions.plannerContext?: 'prepared' | 'conversation'` (default
   `prepared`) and `plannerContextBuilder?: IPlannerContextBuilder` (custom builder, prepared mode only).
   `conversation` mode sends the same planner message array as today. The new tools and the prompt lines
   are present in both modes. Worker history (`selectHistory`) reads the raw conversation in both modes.

## Non-goals

- No LLM summarisation; the digest is built from records deterministically.
- No multiple concurrent plans or per-request plan ownership; the single plan model stays.
- No change to worker context builders or to the planner's in-call tool loop.

## Design

### Contract (`@mcp-abap-adt/llm-agent`)

```ts
export interface PlannerRequestRecord {
  id: string;                  // r<n>, allocated from a persisted counter
  openedAt: number;
  closedAt?: number;
  text: string;                // first user input of the request
  plan?: { status: 'active' | 'waiting_user' | 'done'; steps: number; done: number; failed: number; skipped: number };
  replies: string[];           // final PlannerMessage ids
  lastTurnOk?: boolean;        // the latest session turn ended with a successful planner reply
  closedPlan?: Plan;           // the plan archived by new_request()
  transcript: Message[];       // the request's conversation messages (see bounds)
  legacy?: true;               // reconstructed from an old state
}
export interface PlannerContextInput {
  open?: PlannerRequestRecord;               // undefined only before the first request
  closed: readonly PlannerRequestRecord[];   // newest last
  notes: string[];                           // [plan], budget notes, [environment]
}
export interface IPlannerContextBuilder {
  build(input: PlannerContextInput): Message[];   // must not mutate input
}
```

`DialogueState` gains optional `requests?: PlannerRequestRecord[]`, `requestSeq?: number` and
`messages?: PlannerMessage[]` (archive of final messages). Old states without them still load.

### Session

- **Open/close.** At the start of a user turn (the consumed input, before `appendInput` and before the
  plan is touched), apply the automatic rule from Terms; otherwise the input joins the open request
  (including `waiting_user` answers: question, answer and `scopeConsent` stay in the same transcript, as
  today) and the planner may call `new_request()`. Because users are drained before events, a queued
  event keeps the input in the open request, so the old plan's final event reply never lands in a new
  request automatically. `lastTurnOk` is set at the end of every session turn.
- **Transcript (stored).** The open request's transcript is appended independently of `conversation`:
  a new request starts with its own user input as the first message; every later user input, note,
  reply and `[actions]` is stored as its own message (no merging in storage). The projection merges
  consecutive same-role messages for role alternation, applying per-message cuts to the stored parts, so
  the latest user input is never hidden behind a large note. The raw `conversation` keeps today's behaviour for
  worker history and `conversation` mode. A stored transcript keeps up to 400 messages / 400 000
  characters: beyond that the oldest messages after the first are dropped, with a
  `[dropped n earlier messages]` marker after the first message; the first and the newest message are
  never dropped. A single message longer than 150 000 characters is stored as its first 150 000
  characters plus `[stored cut: 150000 of <total> characters]` (markers count towards the total, so
  the first and newest messages together always fit the 400 000 bound) (this loss is the only irreversible cut and
  is visible to the planner).
- **Transcript (projection).** The planner sees a projection of the open transcript bounded to 60 000
  characters including markers: the first message and the newest messages; any single message longer than
  20 000 characters is projected as its first 20 000 characters plus
  `[cut: <shown> of <total>; get_request <id> offset <n>]`; elided middle messages become one
  `[elided <n> messages; get_request <id>]` note. The stored transcript is never modified by projection,
  so `get_request` serves the open request and closed requests alike.
- **Build per call.** Inside the correction loop, each planner call builds messages from the current
  records (so corrective calls see the intermediate reply, `[actions]` and `[check]`), then prepends the
  notes to the last message as today.
- **Archive.** Each final `PlannerMessage` (user or event reply, not suppressed `NO_MESSAGE`) is added to
  `messages` and its id to the open request's `replies` before `onMessage` / delivery and before the save
  of that turn. The archive keeps the newest 100 messages; `pending` is independent and keeps undelivered
  messages until acknowledged regardless of archive eviction. Evicted ids answer "expired".
- **Plan counters** of the open request are recomputed on every `changed()` (task events mutate the plan
  outside turns), so the snapshot at close is current.
- **Restore.** Old state without `requests`: the restored conversation becomes the transcript of one open
  request `r1` marked `legacy` with `lastTurnOk: true` (lossy: no boundaries, no reply ids); `messages`
  is seeded from `pending`.
  The first later user input with a `done`/absent plan closes it normally.

### Default builder

```
[session] earlier requests of this session (newest last); read with get_request / get_message:
r1 · plan done · 6/6 steps · "<text>" · replies <id>, <id>
r2 · plan waiting_user · 1/2 steps · "<text>" · replies <id>
<open request transcript, chronological>
```

The `[session]` line goes into the first message of the transcript; without closed requests it is
omitted, so a fresh session's first request sends exactly today's messages.

### Prompt (universal lines)

- `[session] lists earlier requests with their reply ids; read earlier content with get_request /
  get_message only when the current request needs it.`
- `To work on an earlier result, pass its message id in delegate_task inputs instead of copying it;
  change only what the request asks.`
- `When a user input starts work unrelated to the current request, call new_request() first; never for
  answers, corrections or follow-ups of the current request.`

## Tests

- Builder: fresh session → today's messages; two closed requests → digest lines; open transcript complete
  and chronological; input not mutated.
- Requests: new input with done plan opens a request; `waiting_user` answer joins the open request with
  question, answer and consent; follow-up while active joins; event turns join the open request;
  corrective calls see intermediate replies and `[check]`; failed planner call then retry stays in the
  same request; counters updated by task events outside turns; two synchronous sends (the second's
  request follows the automatic rule after the first turn: joins when the first left work, a question or
  a failed turn; opens otherwise); `waiting_user` with zero steps keeps the answer in its request; a
  retry after an earlier success and a later failed turn joins; `new_request()` after a failed plan
  closes the request, archives the plan, resets it, and a following update_plan with new steps succeeds
  without consent; running tasks of the closed request still deliver events; a send during an in-flight
  planner call does not move that turn's replies; `new_request()` eligibility errors (event turn,
  corrective call, after any other tool call such as list_tasks or get_plan, twice, in an answer turn
  whose plan was waiting_user at entry); text streamed before `new_request()` is not part of the reply;
  `new_request() → list_tasks → list_tasks` with an old task running follows wait mode normally; `new_request() →
  update_plan → reply` in one call lands entirely in the new request; late events of a closed request's
  task with a reused step id are labelled with their request and leave the new plan unchanged;
  a user input consumed while the final event of the old plan is queued joins the old request; a new
  request after a failed/blocked plan with nothing running opens a new request; the transcript of a new
  request does not contain the previous request's `[actions]`; a short user input after a large note is
  stored as its own message and visible in the projection; legacy restore then a first input with a
  done plan opens a new request.
- Stored transcript: first and newest message survive the count/size bound; a message over 150 000
  characters is stored cut with the marker; oversized first and newest messages together fit the bound; `get_request` returns bounded metadata and one page.
- Projection: 60 000-character cap including markers; oversized first or last message cut with the
  `[cut …]` marker; elided middle note; stored transcript unchanged; `get_request` pages the open request.
- Second request's planner calls contain no text of the first request's replies; size test: a 7 KB first
  reply adds only the digest line to the second request's planner input; long open request elides the
  middle with the note.
- Archive: final replies archived before delivery; `NO_MESSAGE` not archived; eviction with pending
  messages keeps pending; acknowledgement during an in-flight save.
- Tools: `get_message` / `get_request` paging, max limit, invalid offsets, unknown/expired ids; not status
  reads. `delegate_task inputs`: resolution order after context, labels, per-input and total bounds fail
  with a tool error, ranges, max 5, duplicates, unknown id; `history` unchanged in both modes.
- Restore: legacy state → one legacy open request; new state round trip; partially populated fields;
  `requestSeq` continuity.
- Mode `conversation`: planner message array identical to today.

## Rollout

- llm-agent minor (contract) + llm-agent-libs minor (behaviour), default `prepared`.
- Hub: bump; check the hub planner-prompt additions for references to full history.
- Measure on POC: two complex requests in one session plus an iterative follow-up, against the
  2026-10-28 baseline (second request: 541k first planner turn, 920k planner total).

## Decided

- Single plan, one open request; event batches belong to the open request.
- Opaque message ids (existing UUIDs); request ids `r<n>` from a persisted counter.
- Truncation of referenced inputs fails explicitly; ranges are the way to pass part of a message.
- `conversation` mode compatibility covers the planner message array, not the tool list or prompt lines.
