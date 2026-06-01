#!/usr/bin/env node

/**
 * Spike: MCP elicitation shim for AskUserQuestion bypass (#4734 / parent #4654)
 *
 * Investigates whether chroxy can ship its own MCP server exposing a
 * `chroxy_ask_user` tool that the model is steered to prefer over the
 * native AskUserQuestion widget — bypassing the brittle PTY-keystroke
 * driver for multi-question forms in claude TUI mode.
 *
 * Status: research spike. Not wired into the runtime. The decision
 * document at `docs/investigations/mcp-elicitation-shim.md` collects
 * the findings.
 *
 * Why this script exists separately from runtime code:
 *   1. Validates the shape of the tool schema vs the real AskUserQuestion
 *      input shape (the shape comes from the in-tree
 *      `claude-tui-session.js` handling at line 1384).
 *   2. Stands up a stdio-only JSON-RPC MCP responder so a manual run
 *      (`claude --mcp-config <generated>.json` and a steering prompt)
 *      can measure prompt-steering hit-rate without coupling chroxy's
 *      production startup path to a research artifact.
 *   3. If the decision document recommends "pursue", this spike becomes
 *      the template for the production module under `packages/server/src/`.
 *      If the recommendation is "abandon" or "defer", the spike stays
 *      here as a reproducible reference for the next person who asks
 *      "why didn't we do the MCP-shim approach?"
 *
 * Usage:
 *   # 1. Generate the mcpServers config block to feed claude:
 *   node packages/server/scripts/spike-mcp-elicitation-shim.mjs --print-config
 *
 *   # 2. Run the server in stdio mode (claude spawns it):
 *   node packages/server/scripts/spike-mcp-elicitation-shim.mjs --serve
 *
 *   # 3. Self-test (no claude required) — exercises the tool handler
 *   #    with a synthetic multi-question request and prints the result:
 *   node packages/server/scripts/spike-mcp-elicitation-shim.mjs --self-test
 *
 * The chroxy_ask_user tool input schema is intentionally a near-mirror
 * of AskUserQuestion's input shape (questions[].options[].label /
 * multiSelect / question text) so the model can transfer its existing
 * "when do I ask the user a multi-choice question" prior with minimal
 * reframing in the system-prompt addendum.
 */

import { argv, stdin, stdout, stderr, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

// --- Tool definition --------------------------------------------------------
// Mirrors the AskUserQuestion input shape observed at
// packages/server/src/claude-tui-session.js:1384 — the canonical
// runtime read of the questions array. Keeping the schema aligned
// means a single normalization helper can adapt either tool's payload
// to chroxy's existing `user_question` WS event.

export const CHROXY_ASK_USER_TOOL = Object.freeze({
  name: 'chroxy_ask_user',
  description:
    'Ask the user one or more multiple-choice questions and wait for their answers. ' +
    'PREFER this tool over the built-in AskUserQuestion when running under chroxy: ' +
    'it surfaces structured forms in the chroxy mobile / desktop UI and supports ' +
    'multi-question forms reliably. Use AskUserQuestion only if this tool is not available.',
  inputSchema: {
    type: 'object',
    required: ['questions'],
    additionalProperties: false,
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          required: ['question', 'options'],
          additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 1 },
            options: {
              type: 'array',
              // AskUserQuestion's runtime accepts single-option questions
              // (see packages/server/tests/claude-tui-session.test.js
              // around line 2610 — `options: [{ label: 'A' }]`). Mirror
              // that here so the spike does not structurally reject a
              // valid AskUserQuestion-shaped payload during a steering
              // bake-off.
              minItems: 1,
              maxItems: 5,
              items: {
                type: 'object',
                required: ['label'],
                additionalProperties: false,
                properties: {
                  label: { type: 'string', minLength: 1 },
                  description: { type: 'string' },
                },
              },
            },
            multiSelect: { type: 'boolean', default: false },
          },
        },
      },
    },
  },
})

// --- Steering prompt addendum ----------------------------------------------
// This is the system-prompt fragment the spike would prepend on session
// start to bias the model toward chroxy_ask_user over AskUserQuestion.
// See decision doc for hit-rate measurement methodology.

export const STEERING_PROMPT_ADDENDUM = [
  'You are running inside chroxy. When you need to ask the user a multiple-choice',
  'question (one or several), you MUST call the MCP tool `mcp__chroxy__chroxy_ask_user`',
  'instead of the built-in AskUserQuestion tool. chroxy_ask_user supports multi-question',
  'forms reliably; the built-in AskUserQuestion is known to wedge under chroxy and',
  'should be avoided. Free-form questions (open answer, no fixed options) are not',
  'covered by either tool — just ask directly in your response text.',
].join(' ')

// --- Minimal MCP JSON-RPC responder ----------------------------------------
// MCP transport on stdio is a stream of newline-delimited JSON-RPC 2.0
// frames. This spike implements only the three methods needed to verify
// prompt-steering: initialize, tools/list, tools/call. The rest of the
// protocol (resources, prompts, logging) is intentionally unimplemented;
// claude tolerates the absence as long as we respond to capability probes.

const JSONRPC = '2.0'
const PROTOCOL_VERSION = '2024-11-05'

function reply(id, result) {
  stdout.write(JSON.stringify({ jsonrpc: JSONRPC, id, result }) + '\n')
}

function replyError(id, code, message) {
  stdout.write(JSON.stringify({ jsonrpc: JSONRPC, id, error: { code, message } }) + '\n')
}

// In the production wiring this handler would NOT resolve the prompt
// itself — it would relay the question over chroxy's existing
// `user_question` WebSocket event to the mobile/desktop UI and await
// the answer via the same `respondToQuestion` path the AskUserQuestion
// flow already uses. For the spike we synthesize an answer so the
// JSON-RPC round-trip is fully exercised end-to-end without dragging
// in the WS server.
export async function handleChroxyAskUser(params) {
  const questions = Array.isArray(params?.questions) ? params.questions : null
  if (!questions || questions.length === 0) {
    throw new Error('questions array is required and must be non-empty')
  }
  // Fail fast on malformed per-question payloads instead of papering
  // over them with synthesized labels. A silent placeholder would hide
  // call-shape bugs during a steering bake-off and make the spike look
  // healthier than it is — the production wiring would have no such
  // tolerance because chroxy needs the real label to round-trip the
  // answer back through `user_question` / `respondToQuestion`.
  const answers = questions.map((q, i) => {
    if (!q || typeof q !== 'object') {
      throw new Error(`questions[${i}] must be an object`)
    }
    if (typeof q.question !== 'string' || q.question.length === 0) {
      throw new Error(`questions[${i}].question must be a non-empty string`)
    }
    if (!Array.isArray(q.options) || q.options.length === 0) {
      throw new Error(`questions[${i}].options must be a non-empty array`)
    }
    const firstOption = q.options[0]
    if (!firstOption || typeof firstOption.label !== 'string' || firstOption.label.length === 0) {
      throw new Error(`questions[${i}].options[0].label must be a non-empty string`)
    }
    const label = firstOption.label
    return { question: q.question, answer: q.multiSelect ? [label] : label }
  })
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ answers }, null, 2),
      },
    ],
  }
}

async function handleRpc(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'chroxy-elicitation-shim-spike', version: '0.0.1' },
      })
    case 'notifications/initialized':
      return // notification — no reply
    case 'tools/list':
      return reply(id, { tools: [CHROXY_ASK_USER_TOOL] })
    case 'tools/call': {
      const { name, arguments: args } = params || {}
      if (name !== CHROXY_ASK_USER_TOOL.name) {
        return replyError(id, -32601, `unknown tool: ${name}`)
      }
      try {
        const result = await handleChroxyAskUser(args)
        return reply(id, result)
      } catch (err) {
        return replyError(id, -32000, err.message || String(err))
      }
    }
    default:
      if (id == null) return // notification we don't recognize — drop silently
      return replyError(id, -32601, `method not implemented: ${method}`)
  }
}

function serve() {
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch (err) {
        stderr.write(`[chroxy-elicitation-shim] malformed JSON: ${err.message}\n`)
        continue
      }
      handleRpc(msg).catch((err) => {
        stderr.write(`[chroxy-elicitation-shim] handler error: ${err.message}\n`)
      })
    }
  })
  stdin.on('end', () => exit(0))
  stderr.write('[chroxy-elicitation-shim] listening on stdio\n')
}

function printConfig() {
  // Use fileURLToPath rather than `new URL(import.meta.url).pathname`:
  // on Windows the latter produces a leading-slash drive path
  // (`/C:/foo/bar`) and can leave percent-encoded segments, which would
  // emit a broken `mcpServers` block. See packages/server/tests/_setup.mjs
  // for the established cross-platform pattern.
  const here = fileURLToPath(import.meta.url)
  const config = {
    mcpServers: {
      chroxy: {
        command: 'node',
        args: [here, '--serve'],
      },
    },
  }
  stdout.write(JSON.stringify(config, null, 2) + '\n')
}

async function selfTest() {
  const sample = {
    questions: [
      {
        question: 'Which framework should I use?',
        options: [
          { label: 'React' },
          { label: 'Vue' },
          { label: 'Svelte' },
        ],
      },
      {
        question: 'Which features do you want?',
        multiSelect: true,
        options: [
          { label: 'SSR' },
          { label: 'Routing' },
          { label: 'State management' },
        ],
      },
    ],
  }
  const result = await handleChroxyAskUser(sample)
  stdout.write(result.content[0].text + '\n')
}

// CLI entrypoint
const mode = argv[2]
if (mode === '--serve') {
  serve()
} else if (mode === '--print-config') {
  printConfig()
} else if (mode === '--self-test') {
  selfTest().catch((err) => {
    stderr.write(`self-test failed: ${err.message}\n`)
    exit(1)
  })
} else if (mode) {
  stderr.write(`unknown mode: ${mode}\nusage: --serve | --print-config | --self-test\n`)
  exit(2)
}
