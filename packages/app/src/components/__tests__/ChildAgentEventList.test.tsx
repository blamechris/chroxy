/**
 * ChildAgentEventList (mobile) tests — #5060
 *
 * Covers both the pure reducer (`__reduceEventsForTest`) and the
 * rendered output. The reducer carries the load-bearing logic
 * (per-tool row construction, stream_delta concatenation, defensive
 * synthesis on out-of-order tool_result) and is a verbatim port of the
 * dashboard's reducer, so most assertions live there — pinning parity.
 * Render tests focus on what users see: collapsed by default, expands
 * on tap, surfaces input summary + result text, pulse marker on
 * unresolved rows, stream-text block, and stable testIDs.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import type { ChildAgentEvent } from '@chroxy/store-core';
import {
  ChildAgentEventList,
  __reduceEventsForTest,
} from '../chat/ChildAgentEventList';

function renderList(events: ChildAgentEvent[], parentToolUseId = 'tu-parent') {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ChildAgentEventList events={events} parentToolUseId={parentToolUseId} />,
    );
  });
  return root;
}

function findByTestId(root: renderer.ReactTestRenderer, id: string) {
  return root.root.findAllByProps({ testID: id });
}

function tapRow(root: renderer.ReactTestRenderer, toolUseId: string) {
  const [row] = findByTestId(root, `child-agent-tool-${toolUseId}`);
  expect(row).toBeTruthy();
  act(() => {
    row!.props.onPress();
  });
}

describe('reduceEvents (#5060) — mobile parity with dashboard', () => {
  it('builds one row per child tool_start, in arrival order', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read', input: { file_path: '/a' } } },
      { type: 'tool_start', payload: { toolUseId: 'c2', tool: 'Bash', input: { command: 'ls' } } },
    ]);
    expect(out.tools).toHaveLength(2);
    expect(out.tools[0]?.toolUseId).toBe('c1');
    expect(out.tools[0]?.toolName).toBe('Read');
    expect(out.tools[1]?.toolUseId).toBe('c2');
    expect(out.tools[1]?.toolName).toBe('Bash');
  });

  it('accumulates tool_input_delta partialJson onto the matching row', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'tool_input_delta', payload: { toolUseId: 'c1', partialJson: '{"file_path":' } },
      { type: 'tool_input_delta', payload: { toolUseId: 'c1', partialJson: '"/a"}' } },
    ]);
    expect(out.tools[0]?.inputPartial).toBe('{"file_path":"/a"}');
  });

  it('marks a row resolved when tool_result arrives, captures result text', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'tool_result', payload: { toolUseId: 'c1', result: 'hello\nworld' } },
    ]);
    expect(out.tools[0]?.hasResult).toBe(true);
    expect(out.tools[0]?.result).toBe('hello\nworld');
  });

  it('concatenates stream_delta chunks into assistantText', () => {
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { delta: 'Hello ' } },
      { type: 'stream_delta', payload: { delta: 'world.' } },
    ]);
    expect(out.assistantText).toBe('Hello world.');
    expect(out.tools).toHaveLength(0);
  });

  it('inserts a blank-line boundary when stream_delta messageId changes', () => {
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { messageId: 'r1', delta: 'First.' } },
      { type: 'stream_delta', payload: { messageId: 'r2', delta: 'Second.' } },
    ]);
    expect(out.assistantText).toBe('First.\n\nSecond.');
  });

  it('does not insert a boundary on the very first stream_delta', () => {
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { messageId: 'r1', delta: 'Hi.' } },
    ]);
    expect(out.assistantText).toBe('Hi.');
  });

  it('synthesises a row when tool_result arrives without a preceding tool_start', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_result', payload: { toolUseId: 'cX', result: 'oops' } },
    ]);
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]?.toolUseId).toBe('cX');
    expect(out.tools[0]?.hasResult).toBe(true);
  });

  it('ignores tool_input_delta for an unknown toolUseId (pre-tool_start race)', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_input_delta', payload: { toolUseId: 'unknown', partialJson: 'x' } },
    ]);
    expect(out.tools).toHaveLength(0);
  });

  it('ignores stream_delta chunks without a string delta', () => {
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { delta: null } },
      { type: 'stream_delta', payload: {} },
      { type: 'stream_delta', payload: { delta: 'good' } },
    ]);
    expect(out.assistantText).toBe('good');
  });

  it('ignores unknown event types (forward-compat against future server emits)', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'permission_request', payload: { tool: 'Bash' } },
      { type: 'something_new', payload: { foo: 'bar' } },
    ]);
    expect(out.tools).toHaveLength(1);
    expect(out.assistantText).toBe('');
  });

  it('replays of tool_start preserve resolved state on the row', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'tool_result', payload: { toolUseId: 'c1', result: 'done' } },
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
    ]);
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]?.hasResult).toBe(true);
    expect(out.tools[0]?.result).toBe('done');
  });
});

describe('ChildAgentEventList render (#5060)', () => {
  it('renders nothing when the events array is empty', () => {
    const root = renderList([]);
    expect(root.toJSON()).toBeNull();
  });

  it('shows the Subagent progress header and per-tool rows', () => {
    const root = renderList(
      [
        { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read', input: { file_path: '/a' } } },
        { type: 'tool_result', payload: { toolUseId: 'c1', result: 'hello' } },
      ],
      'tu-parent-2',
    );
    expect(findByTestId(root, 'child-agent-events-tu-parent-2')[0]).toBeTruthy();
    expect(findByTestId(root, 'child-agent-events-header')[0]).toBeTruthy();
    expect(findByTestId(root, 'child-agent-tool-c1')[0]).toBeTruthy();
    const [input] = findByTestId(root, 'child-agent-tool-input-c1');
    expect(input).toBeTruthy();
    expect(input!.props.children).toContain('/a');
  });

  it('rows start collapsed; tapping a row expands the result', () => {
    const root = renderList(
      [
        { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
        { type: 'tool_result', payload: { toolUseId: 'c1', result: 'hello' } },
      ],
      'tu-parent-3',
    );
    expect(findByTestId(root, 'child-agent-tool-result-c1')).toHaveLength(0);
    tapRow(root, 'c1');
    const [result] = findByTestId(root, 'child-agent-tool-result-c1');
    expect(result).toBeTruthy();
    expect(result!.props.children).toBe('hello');
  });

  it('surfaces a pulse marker on rows that have not resolved yet', () => {
    const root = renderList(
      [{ type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } }],
      'tu-parent-4',
    );
    expect(findByTestId(root, 'child-agent-tool-pulse-c1')[0]).toBeTruthy();
  });

  it('does not surface a pulse marker once the row resolves', () => {
    const root = renderList(
      [
        { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
        { type: 'tool_result', payload: { toolUseId: 'c1', result: 'done' } },
      ],
      'tu-parent-4b',
    );
    expect(findByTestId(root, 'child-agent-tool-pulse-c1')).toHaveLength(0);
  });

  it('renders the child stream text block when stream_delta arrived', () => {
    const root = renderList(
      [
        { type: 'stream_delta', payload: { delta: 'Hello ' } },
        { type: 'stream_delta', payload: { delta: 'world.' } },
      ],
      'tu-parent-5',
    );
    const [stream] = findByTestId(root, 'child-agent-stream-text-tu-parent-5');
    expect(stream).toBeTruthy();
    expect(stream!.props.children).toBe('Hello world.');
  });
});
