import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../src/claude-stream.js';
import { createCopilotStreamHandler } from '../src/copilot-stream.js';
import { mapPiRpcEvent } from '../src/pi-rpc.js';

describe('structured agent stream fixtures', () => {
  it('emits TodoWrite tool_use from Claude Code stream JSON', () => {
    const events: unknown[] = [];
    const handler = createClaudeStreamHandler((event: unknown) => events.push(event));
    handler.feed(`${JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-1',
            name: 'TodoWrite',
            input: {
              todos: [{ content: 'Run QA', status: 'pending' }],
            },
          },
        ],
      },
    })}\n`);
    handler.flush();

    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'toolu-1',
      name: 'TodoWrite',
      input: {
        todos: [{ content: 'Run QA', status: 'pending' }],
      },
    });
  });

  it('preserves streamed Claude Code tool input_json_delta payloads', () => {
    const events: unknown[] = [];
    const handler = createClaudeStreamHandler((event: unknown) => events.push(event));

    handler.feed(`${JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-1' } },
    })}\n${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu-1', name: 'Write' },
      },
    })}\n${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"admin-dashboard.html",' },
      },
    })}\n${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"content":"<html></html>"}' },
      },
    })}\n${JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    })}\n${JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'toolu-1', name: 'Write', input: {} }],
      },
    })}\n`);
    handler.flush();

    const toolUses = events.filter((event) => typeof event === 'object' && event !== null && (event as { type?: string }).type === 'tool_use');

    expect(toolUses).toHaveLength(1);
    expect(toolUses).toContainEqual({
      type: 'tool_use',
      id: 'toolu-1',
      name: 'Write',
      input: {
        file_path: 'admin-dashboard.html',
        content: '<html></html>',
      },
    });
  });

  it('emits TodoWrite tool_use from Pi RPC tool_execution events', () => {
    const events: unknown[] = [];
    const send = (_channel: string, payload: unknown) => { events.push(payload); };
    const ctx = { runStartedAt: Date.now(), sentFirstToken: { value: false } };

    mapPiRpcEvent(
      { type: 'tool_execution_start', toolCallId: 'pi-call-1', toolName: 'TodoWrite', args: { todos: [{ content: 'Run QA', status: 'pending' }] } },
      send,
      ctx,
    );
    mapPiRpcEvent(
      { type: 'tool_execution_end', toolCallId: 'pi-call-1', toolName: 'TodoWrite', result: { content: [{ type: 'text', text: 'written' }] }, isError: false },
      send,
      ctx,
    );

    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'pi-call-1',
      name: 'TodoWrite',
      input: { todos: [{ content: 'Run QA', status: 'pending' }] },
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      toolUseId: 'pi-call-1',
      content: 'written',
      isError: false,
    });
  });

  it('recovers tool input when streamed JSON is truncated and the assistant wrapper is empty', () => {
    // Regression for #1914: when Claude Code emits `--include-partial-messages`
    // input_json_delta fragments that fail to parse at content_block_stop
    // (e.g. truncation, dropped fragment), it still sends the final assistant
    // wrapper with `input: {}`. The handler must not emit `input: {}` to the
    // web — that produces `(unnamed)` cards with no diagnostic value. It
    // should instead surface a best-effort parse of the partial JSON so the
    // UI can show the real `file_path`.
    const events: unknown[] = [];
    const handler = createClaudeStreamHandler((event: unknown) => events.push(event));

    handler.feed(`${JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-edit' } },
    })}\n${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu-edit', name: 'Edit' },
      },
    })}\n${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        // Truncated mid-string: the closing `"`, `,` and closing `}` are missing.
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/canvas2-nodes.jsx","old_string":"foo' },
      },
    })}\n${JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    })}\n${JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-edit',
        content: [{ type: 'tool_use', id: 'toolu-edit', name: 'Edit', input: {} }],
      },
    })}\n`);
    handler.flush();

    const toolUses = events.filter(
      (event): event is { type: string; id: string; name: string; input: unknown } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: string }).type === 'tool_use',
    );

    expect(toolUses).toHaveLength(1);
    const use = toolUses[0]!;
    expect(use.id).toBe('toolu-edit');
    expect(use.name).toBe('Edit');
    const input = use.input as Record<string, unknown> | null | undefined;
    // The file path was fully present in the streamed bytes before the stream
    // got cut off. We must recover it instead of dropping to `{}`.
    expect(input).not.toBeNull();
    expect((input as Record<string, unknown>).file_path).toBe('src/canvas2-nodes.jsx');
  });

  it('does not strip a valid Edit input when the assistant wrapper carries it but no stream deltas arrived', () => {
    // Mirror image of the regression: older Claude Code builds (or any build
    // that skips `--include-partial-messages`) deliver tool input ONLY via
    // the final assistant wrapper. The handler must still emit it.
    const events: unknown[] = [];
    const handler = createClaudeStreamHandler((event: unknown) => events.push(event));

    handler.feed(`${JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-edit-2',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-edit-2',
            name: 'Edit',
            input: { file_path: 'src/canvas2-nodes.jsx', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    })}\n`);
    handler.flush();

    const toolUses = events.filter(
      (event): event is { type: string; input: unknown } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: string }).type === 'tool_use',
    );
    expect(toolUses).toHaveLength(1);
    expect((toolUses[0]!.input as Record<string, unknown>).file_path).toBe('src/canvas2-nodes.jsx');
  });

  it('emits TodoWrite tool_use from GitHub Copilot CLI JSON stream', () => {
    const events: unknown[] = [];
    const handler = createCopilotStreamHandler((event: unknown) => events.push(event));
    handler.feed(`${JSON.stringify({
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call-1',
        toolName: 'TodoWrite',
        arguments: {
          todos: [{ content: 'Run QA', status: 'pending' }],
        },
      },
    })}\n`);
    handler.flush();

    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'TodoWrite',
      input: {
        todos: [{ content: 'Run QA', status: 'pending' }],
      },
    });
  });
});
