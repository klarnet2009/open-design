/**
 * Parses Claude Code's `--output-format stream-json --verbose` JSONL stream
 * (with or without `--include-partial-messages`) into a small set of
 * UI-friendly events. With partial messages on, text arrives as
 * `stream_event` deltas; without it (older builds <1.0.86, or any build
 * where the flag isn't passed) text arrives only in the final `assistant`
 * wrapper. We handle both. The UI only needs to know five things:
 *
 *   - status        : high-level lifecycle ("initializing", "requesting",
 *                     "thinking")
 *   - text_delta    : assistant text chunk (gets fed to the artifact parser)
 *   - thinking_delta: extended-thinking chunk (shown in a collapsed block)
 *   - tool_use      : { id, name, input }     (fires when input is complete)
 *   - tool_result   : { tool_use_id, content, is_error }
 *   - usage         : aggregated input/output/cache tokens + cost
 *
 * Callers give us `onEvent({ type, ...payload })`. We track per-content-block
 * state to accumulate partial tool_use input JSON and emit a single
 * `tool_use` event when that block stops.
 */

type StreamEvent = Record<string, unknown>;
type EventSink = (event: StreamEvent) => void;
type BlockState = { type?: unknown; name?: unknown; id?: unknown; input: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createClaudeStreamHandler(onEvent: EventSink) {
  let buffer = '';

  // Per-content-block scratch, keyed by `${messageId}:${blockIndex}`.
  const blocks = new Map<string, BlockState>();
  // Tool uses already emitted from streamed `input_json_delta` data.
  // Claude Code still repeats them in the final assistant wrapper, often with
  // empty `{}` inputs, so we suppress that duplicate emission.
  const streamedToolUseIds = new Set<string>();
  // Best-effort partial inputs recovered from streamed `input_json_delta`
  // bytes that did NOT parse cleanly at content_block_stop (e.g. Windows
  // stdout dropped a fragment mid-tool-call — see #1914). Keyed by tool_use
  // id, consumed by the assistant-wrapper merge below so we surface
  // `file_path` instead of an empty `{}` that renders as "(unnamed)".
  const recoveredToolUseInputs = new Map<string, Record<string, unknown>>();
  // Most recent assistant message id so content_block_* events without an id
  // can be attributed correctly.
  let currentMessageId: string | null = null;
  // Message ids that already streamed text via `stream_event` deltas.
  // When `--include-partial-messages` is OFF (older Claude Code, e.g. 1.0.84
  // pre-flag), no deltas arrive — only the final `assistant` wrapper carries
  // text. The fallback below emits that text once, but we must skip it for
  // newer builds that already streamed deltas, otherwise the message would
  // duplicate.
  const textStreamed = new Set<string>();

  function blockKey(index: unknown): string {
    return `${currentMessageId ?? 'anon'}:${index}`;
  }

  function feed(chunk: string) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        onEvent({ type: 'raw', line });
        continue;
      }
      handleObject(obj);
    }
  }

  function flush() {
    const rem = buffer.trim();
    buffer = '';
    if (!rem) return;
    try {
      handleObject(JSON.parse(rem));
    } catch {
      onEvent({ type: 'raw', line: rem });
    }
  }

  function handleObject(obj: unknown) {
    if (!isRecord(obj)) return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      onEvent({
        type: 'status',
        label: 'initializing',
        model: obj.model ?? null,
        sessionId: obj.session_id ?? null,
      });
      return;
    }

    if (obj.type === 'system' && obj.subtype === 'status') {
      onEvent({ type: 'status', label: obj.status ?? 'working' });
      return;
    }

    if (obj.type === 'stream_event' && isRecord(obj.event)) {
      handleStreamEvent(obj.event);
      return;
    }

    // `assistant` messages are the "block finished" signal for the current
    // content block. For tool_use blocks whose input finished assembling,
    // emit tool_use now with the final parsed input. For text blocks, emit
    // the text as a single delta — but only if no streaming deltas already
    // covered it (older Claude Code without --include-partial-messages
    // delivers text only here; newer builds stream it and would duplicate).
    if (obj.type === 'assistant' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      currentMessageId = typeof obj.message.id === 'string' ? obj.message.id : currentMessageId;
      const msgId = typeof obj.message.id === 'string' ? obj.message.id : null;
      const alreadyStreamed = msgId ? textStreamed.has(msgId) : false;
      // Per-turn `stop_reason` is emitted as `turn_end` AFTER the content
      // blocks have been processed (see below). When `--include-partial-
      // messages` is unsupported, tool_use events surface only from the
      // assistant wrapper here — emitting `turn_end` before that loop
      // would let the daemon's stdin-close handler see an empty
      // `pendingHostAnswers` set and close stdin before the
      // AskUserQuestion tool_use was registered, which made the round
      // trip silently fail. Read the stop_reason now, emit after.
      const stopReason = typeof obj.message.stop_reason === 'string'
        ? obj.message.stop_reason
        : null;
      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_use') {
          if (typeof block.id === 'string' && streamedToolUseIds.has(block.id)) {
            streamedToolUseIds.delete(block.id);
            continue;
          }
          let input: unknown = block.input ?? null;
          if (typeof block.id === 'string') {
            const recovered = recoveredToolUseInputs.get(block.id);
            if (recovered) {
              recoveredToolUseInputs.delete(block.id);
              // Wrapper values are authoritative when present; recovered
              // fragments backfill missing keys (typically `file_path`)
              // so the UI no longer renders the card as "(unnamed)".
              input = isRecord(input)
                ? { ...recovered, ...input }
                : recovered;
            }
          }
          onEvent({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input,
          });
        } else if (
          !alreadyStreamed &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.length > 0
        ) {
          onEvent({ type: 'text_delta', delta: block.text });
        } else if (
          !alreadyStreamed &&
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.length > 0
        ) {
          onEvent({ type: 'thinking_delta', delta: block.thinking });
        }
      }
      // Surface the turn_end signal now that every tool_use in this
      // assistant message has been emitted, so the daemon's stdin-close
      // handler has the up-to-date `pendingHostAnswers` set before
      // deciding whether to close stream-json input stdin.
      if (stopReason) {
        onEvent({ type: 'turn_end', stopReason });
      }
      return;
    }

    // `user` messages in a stream-json transcript are usually tool_result
    // wrappers from prior turns.
    if (obj.type === 'user' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_result') {
          onEvent({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            content: stringifyToolResult(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
      return;
    }

    if (obj.type === 'result') {
      onEvent({
        type: 'usage',
        usage: obj.usage ?? null,
        costUsd: obj.total_cost_usd ?? null,
        durationMs: obj.duration_ms ?? null,
        stopReason: obj.stop_reason ?? null,
      });
      return;
    }
  }

  function handleStreamEvent(ev: Record<string, unknown>) {
    if (ev.type === 'message_start') {
      currentMessageId = isRecord(ev.message) && typeof ev.message.id === 'string' ? ev.message.id : null;
      if (typeof ev.ttft_ms === 'number') {
        onEvent({ type: 'status', label: 'streaming', ttftMs: ev.ttft_ms });
      }
      return;
    }

    if (ev.type === 'content_block_start' && isRecord(ev.content_block)) {
      const key = blockKey(ev.index);
      const block = ev.content_block;
      blocks.set(key, { type: block.type, name: block.name, id: block.id, input: '' });
      if (block.type === 'thinking') {
        onEvent({ type: 'thinking_start' });
      }
      return;
    }

    if (ev.type === 'content_block_delta' && isRecord(ev.delta)) {
      const state = blocks.get(blockKey(ev.index));
      const delta = ev.delta;

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'text_delta', delta: delta.text });
        return;
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'thinking_delta', delta: delta.thinking });
        return;
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        if (state && state.type === 'tool_use') {
          state.input += delta.partial_json;
        }
        return;
      }
    }

    if (ev.type === 'content_block_stop') {
      const key = blockKey(ev.index);
      const state = blocks.get(key);
      if (state && state.type === 'tool_use' && typeof state.id === 'string' && state.input.trim()) {
        try {
          onEvent({
            type: 'tool_use',
            id: state.id,
            name: state.name,
            input: JSON.parse(state.input),
          });
          streamedToolUseIds.add(state.id);
        } catch {
          // Streamed JSON did not parse cleanly — most often because a stdout
          // fragment was dropped mid-tool-call on Windows (#1914). Try to
          // recover whatever values made it through and stash them; the
          // assistant wrapper merge above will surface them as the tool
          // input so the UI shows real file paths instead of "(unnamed)".
          const recovered = bestEffortParsePartialJson(state.input);
          if (recovered) {
            recoveredToolUseInputs.set(state.id, recovered);
          }
        }
      }
      blocks.delete(key);
      return;
    }
  }

  return { feed, flush };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isRecord(c) && c.type === 'text' ? String(c.text) : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content);
}

/**
 * Recovers as much of a streamed tool input object as possible from a JSON
 * fragment that failed to parse. Truncation typically lands inside a string
 * value or at a dangling separator: we close any open string, balance the
 * bracket stack, and progressively strip dangling key/colon/comma tails
 * until a prefix parses. Returns `null` if nothing useful can be salvaged.
 *
 * Scoped to top-level objects because every Claude tool input is an object;
 * arrays/scalars never appear as the outermost shape.
 */
export function bestEffortParsePartialJson(input: string): Record<string, unknown> | null {
  const trimmed = input.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Fall through to repair.
  }

  let body = trimmed;
  for (let attempt = 0; attempt < 64; attempt++) {
    const { stack, inString, escape } = scanJsonState(body);

    let working = body;
    if (escape) working = working.slice(0, -1);
    if (inString) working += '"';

    // Strip dangling separators / orphan key fragments so the closers attach
    // to a balanced position. Repeat until stable — stripping `"key":` can
    // expose a trailing `,` that needs its own pass.
    let prev: string;
    do {
      prev = working;
      working = working.replace(/\s+$/, '');
      working = working.replace(/,$/, '');
      working = working.replace(/("(?:[^"\\]|\\.)*"\s*:\s*)$/, '');
      working = working.replace(/,\s*"(?:[^"\\]|\\.)*"\s*$/, '');
    } while (working !== prev);

    let closers = '';
    for (let i = stack.length - 1; i >= 0; i--) closers += stack[i] === '{' ? '}' : ']';

    try {
      const parsed = JSON.parse(working + closers);
      return isRecord(parsed) ? parsed : null;
    } catch {
      const next = stripTrailingPartialEntry(body);
      if (next === body || next.length === 0) return null;
      body = next;
    }
  }
  return null;
}

function scanJsonState(s: string): { stack: Array<'{' | '['>; inString: boolean; escape: boolean } {
  const stack: Array<'{' | '['> = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return { stack, inString, escape };
}

function stripTrailingPartialEntry(body: string): string {
  // Walk the body, tracking per-container "last safe cut" — either the
  // position just after the container's opening bracket or the position of
  // its most recent top-level comma. When we hit a parse failure, cutting
  // back to the innermost container's last safe point drops the half-written
  // entry without disturbing the rest of the object.
  let inString = false;
  let escape = false;
  const stack: Array<{ lastSep: number }> = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push({ lastSep: i + 1 });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && stack.length > 0) stack[stack.length - 1]!.lastSep = i;
  }
  if (stack.length === 0) return '';
  const top = stack[stack.length - 1]!;
  return body.slice(0, top.lastSep).replace(/[,\s]+$/, '');
}
