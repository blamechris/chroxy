import React from 'react';
import { Switch } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { DEFAULT_BYPASS_CATEGORIES, NOTIFICATION_CATEGORY_ORDER } from '@chroxy/protocol';
import { NotificationPrefsSection } from '../../components/settings/NotificationPrefsSection';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const categories = Object.fromEntries(NOTIFICATION_CATEGORY_ORDER.map((key) => [key, true]));

function mount(bypassCategories?: string[]) {
  let tree!: renderer.ReactTestRenderer;
  const onBypassChange = jest.fn();
  act(() => {
    tree = renderer.create(
      <NotificationPrefsSection
        notifWsClosedError={null}
        notificationPrefsSupported={true}
        notificationPrefs={{
          categories,
          quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' },
          devices: {},
          ...(bypassCategories === undefined ? {} : { bypassCategories }),
        }}
        pushToken={null}
        orderedNotificationCategories={[...NOTIFICATION_CATEGORY_ORDER]}
        handleSetCategory={jest.fn()}
        handleSetDevice={jest.fn()}
        handleSetQuietHours={jest.fn()}
        handleSetBypassCategories={onBypassChange}
        handleClearDevice={jest.fn()}
      />,
    );
  });
  const toggles = tree.root.findAllByType(Switch)
    .filter((toggle) => toggle.props.testID?.startsWith('quiet-hours-bypass-toggle-'));
  return { tree, toggles, onBypassChange };
}

describe('notification preference bypass defaults', () => {
  it('renders exactly the shared default set for a snapshot without bypassCategories', () => {
    const { tree, toggles } = mount();
    expect(toggles).toHaveLength(NOTIFICATION_CATEGORY_ORDER.length);
    const checked = toggles.filter((toggle) => toggle.props.value)
      .map((toggle) => toggle.props.testID.replace('quiet-hours-bypass-toggle-', ''));
    expect(checked.sort()).toEqual([...DEFAULT_BYPASS_CATEGORIES].sort());
    act(() => tree.unmount());
  });

  it.each([{ override: [] }, { override: ['result'] }])('preserves an explicit override: $override', ({ override }) => {
    const { tree, toggles } = mount(override);
    const checked = toggles.filter((toggle) => toggle.props.value)
      .map((toggle) => toggle.props.testID.replace('quiet-hours-bypass-toggle-', ''));
    expect(checked.sort()).toEqual([...override].sort());
    act(() => tree.unmount());
  });

  it('edits a copy of the fallback without mutating the shared frozen default', () => {
    const { tree, toggles, onBypassChange } = mount();
    const result = toggles.find((toggle) => toggle.props.testID === 'quiet-hours-bypass-toggle-result')!;
    act(() => result.props.onValueChange(true));
    expect(onBypassChange).toHaveBeenCalledWith([...DEFAULT_BYPASS_CATEGORIES, 'result']);
    expect(DEFAULT_BYPASS_CATEGORIES).toEqual(['permission', 'activity_error']);
    act(() => tree.unmount());
  });
});
