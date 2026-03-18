import { createLogger } from '../logger.js'
import { validateCwdWithinHome } from '../handler-utils.js'

const log = createLogger('ws')

function handleCreateEnvironment(ws, client, msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined
  const image = (typeof msg.image === 'string' && msg.image.trim()) ? msg.image.trim() : undefined
  const memoryLimit = (typeof msg.memoryLimit === 'string' && msg.memoryLimit.trim()) ? msg.memoryLimit.trim() : undefined
  const cpuLimit = (typeof msg.cpuLimit === 'string' && msg.cpuLimit.trim()) ? msg.cpuLimit.trim() : undefined

  if (!name) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment name is required' })
    return
  }
  if (!cwd) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment cwd is required' })
    return
  }

  const cwdError = validateCwdWithinHome(cwd)
  if (cwdError) {
    ctx.send(ws, { type: 'environment_error', error: cwdError })
    return
  }

  ctx.environmentManager.create({ name, cwd, image, memoryLimit, cpuLimit })
    .then((env) => {
      ctx.send(ws, {
        type: 'environment_created',
        environmentId: env.id,
        name: env.name,
        status: env.status,
      })
      ctx.broadcast({
        type: 'environment_list',
        environments: ctx.environmentManager.list(),
      })
    })
    .catch((err) => {
      log.error(`Failed to create environment: ${err.message}`)
      ctx.send(ws, { type: 'environment_error', error: err.message })
    })
}

function handleListEnvironments(ws, client, msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_list', environments: [] })
    return
  }

  ctx.send(ws, {
    type: 'environment_list',
    environments: ctx.environmentManager.list(),
  })
}

function handleDestroyEnvironment(ws, client, msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const environmentId = (typeof msg.environmentId === 'string' && msg.environmentId.trim())
    ? msg.environmentId.trim() : undefined

  if (!environmentId) {
    ctx.send(ws, { type: 'environment_error', error: 'environmentId is required' })
    return
  }

  ctx.environmentManager.destroy(environmentId)
    .then(() => {
      ctx.send(ws, { type: 'environment_destroyed', environmentId })
      ctx.broadcast({
        type: 'environment_list',
        environments: ctx.environmentManager.list(),
      })
    })
    .catch((err) => {
      log.error(`Failed to destroy environment: ${err.message}`)
      ctx.send(ws, { type: 'environment_error', environmentId, error: err.message })
    })
}

function handleGetEnvironment(ws, client, msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const environmentId = (typeof msg.environmentId === 'string' && msg.environmentId.trim())
    ? msg.environmentId.trim() : undefined

  if (!environmentId) {
    ctx.send(ws, { type: 'environment_error', error: 'environmentId is required' })
    return
  }

  const env = ctx.environmentManager.get(environmentId)
  if (!env) {
    ctx.send(ws, { type: 'environment_error', environmentId, error: 'Environment not found' })
    return
  }

  ctx.send(ws, { type: 'environment_info', environment: env })
}

export const environmentHandlers = {
  create_environment: handleCreateEnvironment,
  list_environments: handleListEnvironments,
  destroy_environment: handleDestroyEnvironment,
  get_environment: handleGetEnvironment,
}
