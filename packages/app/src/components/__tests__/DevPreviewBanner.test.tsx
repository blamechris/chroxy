import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { DevPreviewBanner } from '../DevPreviewBanner';
import { renderPermissionDetail } from '../PermissionDetail';

it('requests consent, offers cancel and presents service posture with 48pt controls', () => {
  const onOpen = jest.fn(() => true), onClose = jest.fn();
  let root!: renderer.ReactTestRenderer;
  act(() => { root = renderer.create(<DevPreviewBanner previews={[]} onOpen={onOpen} onClose={onClose} />); });
  const byId = (id: string) => root.root.findAllByProps({ testID: id })[0];
  act(() => { byId('dev-preview-request-toggle').props.onPress(); });
  act(() => { byId('dev-preview-port').props.onChangeText('3100'); });
  act(() => { byId('dev-preview-request').props.onPress(); });
  expect(onOpen).toHaveBeenCalledWith(3100);
  act(() => { byId('dev-preview-cancel').props.onPress(); });
  expect(onClose).toHaveBeenCalledWith(3100);
  expect(StyleSheet.flatten(byId('dev-preview-request').props.style).minHeight).toBe(48);
  act(() => { root.unmount(); });
});

it('renders immutable target and exposure in the permission detail', () => {
  const element = renderPermissionDetail('dev_preview', { target: { host: '127.0.0.1', port: 3100, pid: 100, command: 'fixture', cwd: '/tmp/fixture' }, exposure: 'Public HTTP URL; no authentication added. No WebSockets.' });
  let root!: renderer.ReactTestRenderer;
  act(() => { root = renderer.create(element!); });
  const serialized = JSON.stringify(root.toJSON());
  expect(serialized).toContain('127.0.0.1');
  expect(serialized).toContain('no authentication added');
  expect(serialized).toContain('Allow once for this connection');
  act(() => { root.unmount(); });
});
