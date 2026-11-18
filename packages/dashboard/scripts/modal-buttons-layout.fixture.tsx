import { createRoot } from 'react-dom/client'
import '../src/theme/theme.css'
import '../src/theme/global.css'
import '../src/theme/components.css'
import { CreateSessionModal } from '../src/components/CreateSessionModal'
import { ConfirmDialog } from '../src/components/ConfirmDialog'
import { DirectoryBrowser } from '../src/components/DirectoryBrowser'
import { Modal } from '../src/components/Modal'
import { useConnectionStore } from '../src/store/connection'

// #8779: mount the REAL modal footers with the production stylesheet, one case
// per page load (`?case=<name>`, chosen by modal-buttons-layout.test.mjs, so the
// roster lives in the test). modal-buttons-layout.test.mjs measures the footer
// buttons in a real browser; jsdom lays nothing out.
//
// Nothing here can reach a daemon or take an action. Every handler is a no-op,
// and the store's request and callback functions that CreateSessionModal reads
// are replaced with no-ops before it mounts. The store is never connected. The
// test also blocks, and fails on, any request leaving the Vite origin and any WebSocket.
const noop = () => {}
useConnectionStore.setState({
  requestDirectoryListing: noop,
  requestDirectoryListingFor: () => noop,
  requestGitRepoCheck: noop,
  requestSessionPreset: noop,
  setDirectoryListingCallback: noop,
  setGitRepoCheckCallback: noop,
  dismissSessionDefaultsNotice: noop,
} as never)

const CASE = new URLSearchParams(window.location.search).get('case') ?? ''

function Case() {
  switch (CASE) {
    case 'new-session':
      return <CreateSessionModal open onClose={noop} onCreate={noop} initialCwd="/work/api" />
    case 'new-session-creating':
      // `isCreating` is the disabled state of Create ("Creating...").
      return <CreateSessionModal open onClose={noop} onCreate={noop} initialCwd="/work/api" isCreating />
    case 'confirm':
      return <ConfirmDialog open title="Discard changes?" message="Unsaved edits will be lost." confirmLabel="Discard" onConfirm={noop} onCancel={noop} />
    case 'confirm-danger':
      return <ConfirmDialog open danger title="Close session?" message="The session will be closed." confirmLabel="Close session" onConfirm={noop} onCancel={noop} />
    case 'directory':
      // Production embeds DirectoryBrowser inside the New Session modal; here it
      // sits in the same Modal shell so its footer is measured in a modal width.
      return (
        <Modal open onClose={noop} title="Choose a directory">
          <DirectoryBrowser
            entries={[{ name: 'api', isDirectory: true }, { name: 'web', isDirectory: true }]}
            currentPath="/work"
            loading={false}
            onNavigate={noop}
            onSelect={noop}
            onCancel={noop}
          />
        </Modal>
      )
    default:
      throw new Error(`modal-buttons-layout fixture: unknown ?case=${CASE}`)
  }
}

createRoot(document.getElementById('root')!).render(<Case />)
