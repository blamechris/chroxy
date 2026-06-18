import type { ComponentProps } from 'react'
import { SettingsPanel } from './SettingsPanel'
import { ShortcutHelp } from './ShortcutHelp'
import { PastedTextModal } from './PastedTextModal'
import { QrModal } from './QrModal'
import { SkillsPanel } from './SkillsPanel'
import { SessionContextMenu } from './SessionContextMenu'
import { CreateSessionModal } from './CreateSessionModal'
import { RepoPresetDrawer } from './RepoPresetDrawer'
import { ConfirmDialog } from './ConfirmDialog'
import { Toast } from './Toast'
import { CommandPalette } from './CommandPalette'

/**
 * AppModals — the dashboard's top-level overlay / modal stack (#5560).
 *
 * Pure presentational grouping extracted verbatim from the tail of App's JSX.
 * Every modal here is a leaf overlay rendered at the page root, fully separate
 * from the main-content / terminal / chat subtree — so grouping them into one
 * component does NOT change the identity of the terminal subtree and cannot
 * cause a remount. App owns all the state; this component only renders it.
 *
 * Props are passed through 1:1 from App; the JSX below enforces the real
 * component prop types, and the interface reuses each component's
 * `ComponentProps` so the wiring stays drift-free.
 */
export interface AppModalsProps {
  // Settings panel
  settingsOpen: boolean
  onSettingsClose: () => void
  showConsoleTab: boolean
  onToggleConsoleTab: (show: boolean) => void
  interventionPingEnabled: boolean
  onToggleInterventionPing: (enabled: boolean) => void
  // Shortcut help
  shortcutHelpOpen: boolean
  onShortcutHelpClose: () => void
  shortcuts: ComponentProps<typeof ShortcutHelp>['shortcuts']
  // Pasted-text inspect modal (#3797)
  inspectedPastedTextId: number | null
  pastedTextBlocks: { id: number; content: string }[]
  onPastedTextClose: () => void
  onRemovePastedText: (id: number) => void
  // QR modal (#3070 / #3070 share)
  qrModalOpen: boolean
  onQrClose: () => void
  qrSvg: string | null
  qrLoading: boolean
  qrError: string | null
  qrShareMode: 'link' | 'share'
  qrPairingCode: string | null
  onPostPairLinkToDiscord: ComponentProps<typeof QrModal>['onPostToDiscord']
  // Skills panel (#3209)
  skillsPanelOpen: boolean
  skills: ComponentProps<typeof SkillsPanel>['skills']
  skillsCanToggle: boolean
  mismatchedSkillNames: ComponentProps<typeof SkillsPanel>['mismatchedSkillNames']
  onActivateSkill: ComponentProps<typeof SkillsPanel>['onActivate']
  onDeactivateSkill: ComponentProps<typeof SkillsPanel>['onDeactivate']
  onAcceptSkillTrust: ComponentProps<typeof SkillsPanel>['onAcceptTrust']
  pendingCommunitySkills: ComponentProps<typeof SkillsPanel>['pendingCommunitySkills']
  onGrantSkillTrust: ComponentProps<typeof SkillsPanel>['onGrantTrust']
  skillsPanelCapabilities: ComponentProps<typeof SkillsPanel>['capabilities']
  pendingTrustGrants: ComponentProps<typeof SkillsPanel>['pendingTrustGrants']
  onSkillsPanelClose: () => void
  // Sidebar right-click context menu (#4045)
  sidebarContextMenu: { x: number; y: number } | null
  sidebarContextMenuItems: ComponentProps<typeof SessionContextMenu>['items']
  onDismissSidebarContextMenu: () => void
  // Create-session modal
  showCreateSession: boolean
  onCreateSessionClose: () => void
  onCreateSession: ComponentProps<typeof CreateSessionModal>['onCreate']
  createSessionInitialCwd: string | null
  knownCwds: string[]
  existingSessionNames: string[]
  sessionCreateError?: string
  isCreatingSession: boolean
  // Per-repo preset drawer (#5553)
  repoPresetDrawer: { path: string; name: string } | null
  onRepoPresetDrawerClose: () => void
  // Session-close confirmation (#5206)
  closeConfirmOpen: boolean
  closeConfirmMessage: string
  onCloseConfirm: () => void
  onCloseConfirmCancel: () => void
  // Toasts
  toastItems: ComponentProps<typeof Toast>['items']
  onToastDismiss: (id: string) => void
  // Command palette
  commands: ComponentProps<typeof CommandPalette>['commands']
  paletteOpen: boolean
  onPaletteClose: () => void
  mruList: ComponentProps<typeof CommandPalette>['mruList']
}

export function AppModals(props: AppModalsProps) {
  const block =
    props.inspectedPastedTextId != null
      ? props.pastedTextBlocks.find(b => b.id === props.inspectedPastedTextId)
      : undefined
  return (
    <>
      {/* Settings panel */}
      <SettingsPanel
        isOpen={props.settingsOpen}
        onClose={props.onSettingsClose}
        showConsoleTab={props.showConsoleTab}
        onToggleConsoleTab={props.onToggleConsoleTab}
        interventionPingEnabled={props.interventionPingEnabled}
        onToggleInterventionPing={props.onToggleInterventionPing}
      />

      {/* Keyboard shortcut help */}
      <ShortcutHelp isOpen={props.shortcutHelpOpen} onClose={props.onShortcutHelpClose} shortcuts={props.shortcuts} />

      {/* Pasted-text inspect modal (#3797) — read-only viewer for the
          collapsed paste whose chip the user clicked. */}
      {props.inspectedPastedTextId != null && block && (
        <PastedTextModal
          id={block.id}
          content={block.content}
          onClose={props.onPastedTextClose}
          onRemove={props.onRemovePastedText}
        />
      )}

      {/* QR code modal — shared by linking-mode QR and per-session "Share" QR (#3070) */}
      <QrModal
        open={props.qrModalOpen}
        onClose={props.onQrClose}
        qrSvg={props.qrSvg}
        loading={props.qrLoading}
        error={props.qrError ?? undefined}
        title={props.qrShareMode === 'share' ? 'Share This Session' : 'Pair Mobile App'}
        instructions={
          props.qrShareMode === 'share'
            ? 'Scan to chat into this session only — the scanner cannot list, switch, or destroy other sessions.'
            : 'Scan with Chroxy app to pair your phone'
        }
        pairingCode={props.qrShareMode === 'share' ? null : props.qrPairingCode}
        onPostToDiscord={props.qrShareMode === 'share' ? undefined : props.onPostPairLinkToDiscord}
      />

      {/* #3209: SkillsPanel — popover for manual-skill toggles + #3205 metadata */}
      {props.skillsPanelOpen && (
        <SkillsPanel
          skills={props.skills}
          canToggle={props.skillsCanToggle}
          mismatchedSkillNames={props.mismatchedSkillNames}
          onActivate={props.onActivateSkill}
          onDeactivate={props.onDeactivateSkill}
          onAcceptTrust={props.onAcceptSkillTrust}
          pendingCommunitySkills={props.pendingCommunitySkills}
          onGrantTrust={props.onGrantSkillTrust}
          capabilities={props.skillsPanelCapabilities}
          pendingTrustGrants={props.pendingTrustGrants}
          onClose={props.onSkillsPanelClose}
        />
      )}

      {/* #4045: sidebar right-click context menu. Rendered at top level so
          it floats above the sidebar without inheriting clip/overflow from
          ancestor containers; SessionContextMenu handles its own outside-
          click / Esc / blur dismissal. */}
      {props.sidebarContextMenu && (
        <SessionContextMenu
          x={props.sidebarContextMenu.x}
          y={props.sidebarContextMenu.y}
          items={props.sidebarContextMenuItems}
          onDismiss={props.onDismissSidebarContextMenu}
        />
      )}

      {/* Modals */}
      <CreateSessionModal
        open={props.showCreateSession}
        onClose={props.onCreateSessionClose}
        onCreate={props.onCreateSession}
        initialCwd={props.createSessionInitialCwd}
        knownCwds={props.knownCwds}
        existingNames={props.existingSessionNames}
        serverError={props.sessionCreateError}
        isCreating={props.isCreatingSession}
      />

      {/* #5553 — the per-repo settings drawer (session preset editor). Opened
          from a Control Room repo-row gear; one at a time. */}
      {props.repoPresetDrawer && (
        <RepoPresetDrawer
          repoPath={props.repoPresetDrawer.path}
          repoName={props.repoPresetDrawer.name}
          onClose={props.onRepoPresetDrawerClose}
        />
      )}

      {/* #5206 — session-close confirmation. Shown only when the
          confirmSessionClose setting is enabled (handleCloseSession gates it).
          Confirm tears the session down; cancel/Escape/backdrop keep it. */}
      <ConfirmDialog
        open={props.closeConfirmOpen}
        title="Close session?"
        message={props.closeConfirmMessage}
        confirmLabel="Close session"
        cancelLabel="Cancel"
        danger
        onConfirm={props.onCloseConfirm}
        onCancel={props.onCloseConfirmCancel}
      />

      {/* Toasts */}
      <Toast items={props.toastItems} onDismiss={props.onToastDismiss} />

      {/* Command palette */}
      <CommandPalette
        commands={props.commands}
        isOpen={props.paletteOpen}
        onClose={props.onPaletteClose}
        mruList={props.mruList}
      />
    </>
  )
}
