import { describe, it, expect, vi, afterEach } from 'vitest'
import { ListDirectorySchema, ServerDirectoryListingSchema } from '@chroxy/protocol/schemas'
import { useConnectionStore } from './connection'
import { handleMessage } from './message-handler'

afterEach(() => useConnectionStore.setState({ socket: null, _directoryListingCallback: null }))

describe('directory request correlation through the store', () => {
  it('carries the request id through sending, schema parsing and the real response handler', () => {
    const send = vi.fn()
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket
    const callback = vi.fn()
    useConnectionStore.setState({ socket, _directoryListingCallback: callback })
    useConnectionStore.getState().requestDirectoryListing('/workspace//project', 'directory-1')
    const sent = ListDirectorySchema.parse(JSON.parse(send.mock.calls[0]![0]))
    expect(sent.requestId).toBe('directory-1')
    handleMessage(ServerDirectoryListingSchema.parse({
      type: 'directory_listing', path: '/workspace/project', parentPath: '/workspace',
      entries: [], error: null, requestId: sent.requestId,
    }), { url: 'ws://localhost', token: 'test', socket, isReconnect: false, silent: false })
    expect(callback).toHaveBeenCalledWith({
      path: '/workspace/project', parentPath: '/workspace', entries: [], error: null, requestId: 'directory-1',
    })
  })
})
