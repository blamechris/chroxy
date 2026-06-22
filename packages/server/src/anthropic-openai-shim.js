/**
 * Network glue for the OpenAI-compatible provider (#5420).
 *
 * `ClaudeByokSession` drives `@anthropic-ai/sdk`'s `client.messages.stream(...)`:
 * it passes an Anthropic Messages request, consumes an async iterable of raw SDK
 * events (message_start / content_block_* / message_delta / message_stop), then
 * reads `stream.finalMessage()`. To reach OpenAI-compatible servers (LM Studio,
 * vLLM, llama.cpp, OpenRouter, …) without forking that loop, this shim reproduces
 * that surface but speaks OpenAI chat-completions underneath.
 *
 * The pure translation (request shape + the streaming-chunk fold into Anthropic
 * SDK events + the final Message) lives in anthropic-openai-translate.js (#6127).
 * This module is the thin I/O layer: it imports `openai`, awaits the SSE
 * iterator, feeds each chunk through `createStreamTranslator()`, and exposes the
 * async-iterable + `.finalMessage()` the byok loop expects. Keeping it this thin
 * means the translation stays fixture-testable with no live endpoint, and this
 * file is exercised with a MOCKED `openai` package (no network).
 *
 * The emitted event objects match the RAW Anthropic SDK shapes that
 * byok-event-translator.js switches on — that file is the contract.
 */

import OpenAI from 'openai'
import { anthropicRequestToOpenAi, createStreamTranslator } from './anthropic-openai-translate.js'

/**
 * Build a minimal Anthropic-SDK-shaped client backed by an OpenAI-compatible
 * chat-completions endpoint.
 *
 * Returns `{ messages: { stream(params, opts) } }` where `stream` mirrors
 * `@anthropic-ai/sdk`'s `messages.stream`: it returns an object that is
 * async-iterable over the translated Anthropic SDK events AND exposes
 * `finalMessage()` resolving to the assembled final Message
 * (`{ id, type, role, model, content, stop_reason, stop_sequence, usage }`).
 *
 * @param {{ baseURL: string, apiKey: string }} cfg
 * @returns {{ messages: { stream: (params: object, opts?: { signal?: AbortSignal }) => object } }}
 */
export function createAnthropicShimClient({ baseURL, apiKey }) {
  const client = new OpenAI({ baseURL, apiKey })

  return {
    messages: {
      stream(params = {}, opts = {}) {
        return createShimStream(client, params, opts)
      },
    },
  }
}

/**
 * The async-iterable + finalMessage object returned by `messages.stream`.
 *
 * Iteration is single-pass: it opens the OpenAI stream lazily on the first
 * iteration, folds each chunk through the translator (yielding Anthropic events),
 * then flushes the translator's trailing events on stream end. The assembled
 * final Message is captured during iteration so `finalMessage()` resolves once
 * iteration completes (the byok loop always fully iterates before awaiting it).
 *
 * @param {object} client - the OpenAI client
 * @param {object} params - Anthropic Messages params
 * @param {{ signal?: AbortSignal }} opts
 */
function createShimStream(client, params, opts) {
  const signal = opts?.signal
  const translator = createStreamTranslator()
  let finalMessage = null

  async function* iterate() {
    const request = {
      ...anthropicRequestToOpenAi(params),
      stream: true,
      // Ask for usage on the final chunk where the server supports it
      // (OpenAI / vLLM / many proxies); mapUsage defaults to zero otherwise.
      stream_options: { include_usage: true },
    }

    const openaiStream = await client.chat.completions.create(request, { signal })

    for await (const chunk of openaiStream) {
      for (const event of translator.push(chunk)) yield event
    }

    const { events, finalMessage: assembled } = translator.finish()
    finalMessage = assembled
    for (const event of events) yield event
  }

  const iterable = iterate()

  return {
    [Symbol.asyncIterator]() {
      return iterable
    },
    async finalMessage() {
      // The byok loop fully drains the iterator before calling this, so the
      // translator has already been finished and `finalMessage` is populated.
      // Guard defensively: if a caller asks early, drain the remaining events
      // (discarding them) so `finish()` runs and the message is assembled.
      if (finalMessage === null) {
        // Drain remaining events so the generator runs finish() and assembles
        // the message (the events themselves are discarded on this path).
        // eslint-disable-next-line no-unused-vars
        for await (const _event of iterable) { /* drain */ }
      }
      return finalMessage
    },
  }
}
