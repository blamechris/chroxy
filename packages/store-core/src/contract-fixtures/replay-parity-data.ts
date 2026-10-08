/**
 * Scenario data for the live-vs-replay parity contract (#6630): per scenario, the
 * session events (AUTHORED here -- add or edit them, then regenerate) and the
 * `live` and `replay` wire frames the server produces for them (GENERATED: never
 * edit those by hand). Regenerate with
 *
 *   cd packages/server && UPDATE_REPLAY_PARITY=1 node --import ./tests/_setup.mjs --test tests/replay-parity-wire.test.js
 *
 * `tests/replay-parity-wire.test.js` re-derives every frame from the real server
 * code and fails when a committed frame is stale.
 *
 * It is a TypeScript module and not a JSON file on purpose: the package's publish
 * build (`scripts/build-publish-dir.mjs`) emits ESM that Node refuses to load
 * with a bare JSON import, and the barrel re-exports the fixtures. The server test
 * reads the JSON between the two markers below.
 */
// prettier-ignore
export const REPLAY_PARITY_DATA = /* json:start */ {
  "scenarios": [
    {
      "name": "plain-reply",
      "description": "A reply with no tools: one response bubble.",
      "providers": [
        "claude-sdk",
        "claude-tui"
      ],
      "events": [
        [
          "stream_start",
          {
            "messageId": "m1"
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "m1",
            "delta": "Hello, "
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "m1",
            "delta": "world."
          }
        ],
        [
          "stream_end",
          {
            "messageId": "m1"
          }
        ],
        [
          "result",
          {
            "cost": 0.0123,
            "duration": 4200,
            "usage": {
              "input_tokens": 120,
              "output_tokens": 40
            },
            "sessionId": "s1"
          }
        ]
      ],
      "live": [
        {
          "type": "stream_start",
          "messageId": "m1",
          "sessionId": "s1"
        },
        {
          "type": "agent_busy",
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "m1",
          "delta": "Hello, ",
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "m1",
          "delta": "world.",
          "sessionId": "s1"
        },
        {
          "type": "stream_end",
          "messageId": "m1",
          "sessionId": "s1"
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "sessionId": "s1"
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "message",
          "messageType": "response",
          "content": "Hello, world.",
          "messageId": "m1",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ]
    },
    {
      "name": "thinking-then-reply",
      "description": "An extended-thinking block followed by the reply (claude-sdk streams reasoning as its own thinking:true stream).",
      "providers": [
        "claude-sdk"
      ],
      "events": [
        [
          "stream_start",
          {
            "messageId": "t1-thinking-0",
            "thinking": true
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "t1-thinking-0",
            "delta": "The user wants a greeting. ",
            "thinking": true
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "t1-thinking-0",
            "delta": "Keep it short.",
            "thinking": true
          }
        ],
        [
          "stream_end",
          {
            "messageId": "t1-thinking-0",
            "thinking": true,
            "thinkingDurationMs": 1200,
            "thinkingTokens": 128
          }
        ],
        [
          "stream_start",
          {
            "messageId": "t1"
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "t1",
            "delta": "Hi there."
          }
        ],
        [
          "stream_end",
          {
            "messageId": "t1"
          }
        ],
        [
          "result",
          {
            "cost": 0.0123,
            "duration": 4200,
            "usage": {
              "input_tokens": 120,
              "output_tokens": 40
            },
            "sessionId": "s1"
          }
        ]
      ],
      "live": [
        {
          "type": "stream_start",
          "messageId": "t1-thinking-0",
          "thinking": true,
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "t1-thinking-0",
          "delta": "The user wants a greeting. ",
          "thinking": true,
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "t1-thinking-0",
          "delta": "Keep it short.",
          "thinking": true,
          "sessionId": "s1"
        },
        {
          "type": "stream_end",
          "messageId": "t1-thinking-0",
          "thinking": true,
          "thinkingDurationMs": 1200,
          "thinkingTokens": 128,
          "sessionId": "s1"
        },
        {
          "type": "stream_start",
          "messageId": "t1",
          "sessionId": "s1"
        },
        {
          "type": "agent_busy",
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "t1",
          "delta": "Hi there.",
          "sessionId": "s1"
        },
        {
          "type": "stream_end",
          "messageId": "t1",
          "sessionId": "s1"
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "sessionId": "s1"
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "message",
          "messageType": "response",
          "content": "The user wants a greeting. Keep it short.",
          "messageId": "t1-thinking-0",
          "kind": "thinking",
          "thinkingDurationMs": 1200,
          "thinkingTokens": 128,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "message",
          "messageType": "response",
          "content": "Hi there.",
          "messageId": "t1",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 3
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ]
    },
    {
      "name": "thinking-without-text",
      "description": "Reasoning whose text the model does not return (the signature_delta-only block current Claude models send): the SDK still opens and closes a thinking stream, so the live client shows a \"thought for Xs\" bubble with an empty body.",
      "providers": [
        "claude-sdk"
      ],
      "events": [
        [
          "stream_start",
          {
            "messageId": "t2-thinking-0",
            "thinking": true
          }
        ],
        [
          "stream_end",
          {
            "messageId": "t2-thinking-0",
            "thinking": true,
            "thinkingDurationMs": 1000
          }
        ],
        [
          "stream_start",
          {
            "messageId": "t2"
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "t2",
            "delta": "Done."
          }
        ],
        [
          "stream_end",
          {
            "messageId": "t2"
          }
        ],
        [
          "result",
          {
            "cost": 0.0123,
            "duration": 4200,
            "usage": {
              "input_tokens": 120,
              "output_tokens": 40
            },
            "sessionId": "s1"
          }
        ]
      ],
      "live": [
        {
          "type": "stream_start",
          "messageId": "t2-thinking-0",
          "thinking": true,
          "sessionId": "s1"
        },
        {
          "type": "stream_end",
          "messageId": "t2-thinking-0",
          "thinking": true,
          "thinkingDurationMs": 1000,
          "sessionId": "s1"
        },
        {
          "type": "stream_start",
          "messageId": "t2",
          "sessionId": "s1"
        },
        {
          "type": "agent_busy",
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "t2",
          "delta": "Done.",
          "sessionId": "s1"
        },
        {
          "type": "stream_end",
          "messageId": "t2",
          "sessionId": "s1"
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "sessionId": "s1"
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "message",
          "messageType": "response",
          "content": "",
          "messageId": "t2-thinking-0",
          "kind": "thinking",
          "thinkingDurationMs": 1000,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "message",
          "messageType": "response",
          "content": "Done.",
          "messageId": "t2",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 3
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ]
    },
    {
      "name": "text-around-a-tool",
      "description": "claude-sdk text, a tool call, then more text in the same turn. The live client splits the turn into two bubbles around the tool; the replay records one response entry per stream.",
      "providers": [
        "claude-sdk"
      ],
      "events": [
        [
          "stream_start",
          {
            "messageId": "m1"
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "m1",
            "delta": "Let me read the file. "
          }
        ],
        [
          "tool_start",
          {
            "messageId": "tu1",
            "toolUseId": "tu1",
            "tool": "Read",
            "input": null
          }
        ],
        [
          "tool_result",
          {
            "toolUseId": "tu1",
            "result": "export const x = 1",
            "truncated": false,
            "input": {
              "file_path": "/repo/a.js"
            }
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "m1",
            "delta": "It exports one constant."
          }
        ],
        [
          "stream_end",
          {
            "messageId": "m1"
          }
        ],
        [
          "result",
          {
            "cost": 0.0123,
            "duration": 4200,
            "usage": {
              "input_tokens": 120,
              "output_tokens": 40
            },
            "sessionId": "s1"
          }
        ]
      ],
      "live": [
        {
          "type": "stream_start",
          "messageId": "m1",
          "sessionId": "s1"
        },
        {
          "type": "agent_busy",
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "m1",
          "delta": "Let me read the file. ",
          "sessionId": "s1"
        },
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "Read",
          "input": null,
          "sessionId": "s1"
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "export const x = 1",
          "truncated": false,
          "input": {
            "file_path": "/repo/a.js"
          },
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "m1",
          "delta": "It exports one constant.",
          "sessionId": "s1"
        },
        {
          "type": "stream_end",
          "messageId": "m1",
          "sessionId": "s1"
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "sessionId": "s1"
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "Read",
          "input": {
            "file_path": "/repo/a.js"
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "export const x = 1",
          "truncated": false,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "message",
          "messageType": "response",
          "content": "Let me read the file. It exports one constant.",
          "messageId": "m1",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 3
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 4
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ]
    },
    {
      "name": "tools-then-summary-tui",
      "description": "claude-tui: the turn opens a stream at the start, tools run, the summary arrives in one burst at the end.",
      "providers": [
        "claude-tui"
      ],
      "events": [
        [
          "stream_start",
          {
            "messageId": "m1"
          }
        ],
        [
          "tool_start",
          {
            "messageId": "tu1",
            "toolUseId": "tu1",
            "tool": "Read",
            "input": {
              "file_path": "/repo/a.js"
            }
          }
        ],
        [
          "tool_result",
          {
            "toolUseId": "tu1",
            "result": "export const x = 1",
            "truncated": false
          }
        ],
        [
          "tool_start",
          {
            "messageId": "tu2",
            "toolUseId": "tu2",
            "tool": "Bash",
            "input": {
              "command": "npm test"
            }
          }
        ],
        [
          "tool_result",
          {
            "toolUseId": "tu2",
            "result": "3 passing",
            "truncated": false
          }
        ],
        [
          "stream_delta",
          {
            "messageId": "m1",
            "delta": "Tests pass."
          }
        ],
        [
          "stream_end",
          {
            "messageId": "m1"
          }
        ],
        [
          "result",
          {
            "cost": 0.0123,
            "duration": 4200,
            "usage": {
              "input_tokens": 120,
              "output_tokens": 40
            },
            "sessionId": "s1"
          }
        ]
      ],
      "live": [
        {
          "type": "stream_start",
          "messageId": "m1",
          "sessionId": "s1"
        },
        {
          "type": "agent_busy",
          "sessionId": "s1"
        },
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "Read",
          "input": {
            "file_path": "/repo/a.js"
          },
          "sessionId": "s1"
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "export const x = 1",
          "truncated": false,
          "sessionId": "s1"
        },
        {
          "type": "tool_start",
          "messageId": "tu2",
          "toolUseId": "tu2",
          "tool": "Bash",
          "input": {
            "command": "npm test"
          },
          "sessionId": "s1"
        },
        {
          "type": "tool_result",
          "toolUseId": "tu2",
          "result": "3 passing",
          "truncated": false,
          "sessionId": "s1"
        },
        {
          "type": "stream_delta",
          "messageId": "m1",
          "delta": "Tests pass.",
          "sessionId": "s1"
        },
        {
          "type": "stream_end",
          "messageId": "m1",
          "sessionId": "s1"
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "sessionId": "s1"
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "Read",
          "input": {
            "file_path": "/repo/a.js"
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "export const x = 1",
          "truncated": false,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "tool_start",
          "messageId": "tu2",
          "toolUseId": "tu2",
          "tool": "Bash",
          "input": {
            "command": "npm test"
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 3
        },
        {
          "type": "tool_result",
          "toolUseId": "tu2",
          "result": "3 passing",
          "truncated": false,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 4
        },
        {
          "type": "message",
          "messageType": "response",
          "content": "Tests pass.",
          "messageId": "m1",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 5
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 6
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ]
    },
    {
      "name": "tool-outcomes",
      "description": "An MCP tool (server label), a failed tool, and a tool cut off by Stop.",
      "providers": [
        "claude-sdk",
        "claude-tui"
      ],
      "events": [
        [
          "tool_start",
          {
            "messageId": "tu1",
            "toolUseId": "tu1",
            "tool": "mcp__docs__search",
            "input": {
              "query": "replay"
            },
            "serverName": "docs"
          }
        ],
        [
          "tool_result",
          {
            "toolUseId": "tu1",
            "result": "2 hits",
            "truncated": false
          }
        ],
        [
          "tool_start",
          {
            "messageId": "tu2",
            "toolUseId": "tu2",
            "tool": "Bash",
            "input": {
              "command": "false"
            }
          }
        ],
        [
          "tool_result",
          {
            "toolUseId": "tu2",
            "result": "exit 1",
            "truncated": false,
            "isError": true
          }
        ],
        [
          "tool_start",
          {
            "messageId": "tu3",
            "toolUseId": "tu3",
            "tool": "Bash",
            "input": {
              "command": "sleep 600"
            }
          }
        ],
        [
          "tool_result",
          {
            "toolUseId": "tu3",
            "result": "Turn ended before this tool reported.",
            "truncated": false,
            "isError": true,
            "terminatedReason": "stopped"
          }
        ],
        [
          "result",
          {
            "cost": 0.0123,
            "duration": 4200,
            "usage": {
              "input_tokens": 120,
              "output_tokens": 40
            },
            "sessionId": "s1"
          }
        ]
      ],
      "live": [
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "mcp__docs__search",
          "input": {
            "query": "replay"
          },
          "serverName": "docs",
          "sessionId": "s1"
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "2 hits",
          "truncated": false,
          "sessionId": "s1"
        },
        {
          "type": "tool_start",
          "messageId": "tu2",
          "toolUseId": "tu2",
          "tool": "Bash",
          "input": {
            "command": "false"
          },
          "sessionId": "s1"
        },
        {
          "type": "tool_result",
          "toolUseId": "tu2",
          "result": "exit 1",
          "truncated": false,
          "isError": true,
          "sessionId": "s1"
        },
        {
          "type": "tool_start",
          "messageId": "tu3",
          "toolUseId": "tu3",
          "tool": "Bash",
          "input": {
            "command": "sleep 600"
          },
          "sessionId": "s1"
        },
        {
          "type": "tool_result",
          "toolUseId": "tu3",
          "result": "Turn ended before this tool reported.",
          "truncated": false,
          "isError": true,
          "terminatedReason": "stopped",
          "sessionId": "s1"
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "sessionId": "s1"
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "mcp__docs__search",
          "input": {
            "query": "replay"
          },
          "serverName": "docs",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "2 hits",
          "truncated": false,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "tool_start",
          "messageId": "tu2",
          "toolUseId": "tu2",
          "tool": "Bash",
          "input": {
            "command": "false"
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 3
        },
        {
          "type": "tool_result",
          "toolUseId": "tu2",
          "result": "exit 1",
          "truncated": false,
          "isError": true,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 4
        },
        {
          "type": "tool_start",
          "messageId": "tu3",
          "toolUseId": "tu3",
          "tool": "Bash",
          "input": {
            "command": "sleep 600"
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 5
        },
        {
          "type": "tool_result",
          "toolUseId": "tu3",
          "result": "Turn ended before this tool reported.",
          "truncated": false,
          "isError": true,
          "terminatedReason": "stopped",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 6
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 7
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ]
    },
    {
      "name": "tool-result-image",
      "description": "A tool result that carries an image (a computer-use screenshot).",
      "providers": [
        "claude-sdk"
      ],
      "events": [
        [
          "tool_start",
          {
            "messageId": "tu1",
            "toolUseId": "tu1",
            "tool": "mcp__browser__screenshot",
            "input": {
              "url": "http://localhost"
            },
            "serverName": "browser"
          }
        ],
        [
          "tool_result",
          {
            "toolUseId": "tu1",
            "result": "screenshot taken",
            "truncated": false,
            "images": [
              {
                "mediaType": "image/png",
                "data": "iVBORw0KGgo="
              }
            ]
          }
        ],
        [
          "result",
          {
            "cost": 0.0123,
            "duration": 4200,
            "usage": {
              "input_tokens": 120,
              "output_tokens": 40
            },
            "sessionId": "s1"
          }
        ]
      ],
      "live": [
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "mcp__browser__screenshot",
          "input": {
            "url": "http://localhost"
          },
          "serverName": "browser",
          "sessionId": "s1"
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "screenshot taken",
          "truncated": false,
          "images": [
            {
              "mediaType": "image/png",
              "data": "iVBORw0KGgo="
            }
          ],
          "sessionId": "s1"
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "sessionId": "s1"
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "tool_start",
          "messageId": "tu1",
          "toolUseId": "tu1",
          "tool": "mcp__browser__screenshot",
          "input": {
            "url": "http://localhost"
          },
          "serverName": "browser",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "tool_result",
          "toolUseId": "tu1",
          "result": "screenshot taken",
          "truncated": false,
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "result",
          "cost": 0.0123,
          "duration": 4200,
          "usage": {
            "input_tokens": 120,
            "output_tokens": 40
          },
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 3
        },
        {
          "type": "agent_idle",
          "sessionId": "s1"
        }
      ]
    },
    {
      "name": "error-cards",
      "description": "The error bubbles: a stream stall (chip), a failed resume (chip + id), and a plain error.",
      "providers": [
        "claude-sdk",
        "claude-tui"
      ],
      "events": [
        [
          "error",
          {
            "message": "No response for 90 seconds",
            "code": "stream_stall",
            "timeoutMs": 90000
          }
        ],
        [
          "error",
          {
            "message": "Could not resume the previous conversation",
            "code": "resume_unknown",
            "attemptedResumeId": "conv-123"
          }
        ],
        [
          "error",
          {
            "message": "Something went wrong"
          }
        ]
      ],
      "live": [
        {
          "type": "message",
          "messageType": "error",
          "content": "No response for 90 seconds",
          "timestamp": 1700000000000,
          "code": "stream_stall",
          "timeoutMs": 90000,
          "sessionId": "s1"
        },
        {
          "type": "message",
          "messageType": "error",
          "content": "Could not resume the previous conversation",
          "timestamp": 1700000000000,
          "code": "resume_unknown",
          "attemptedResumeId": "conv-123",
          "sessionId": "s1"
        },
        {
          "type": "message",
          "messageType": "error",
          "content": "Something went wrong",
          "timestamp": 1700000000000,
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "message",
          "messageType": "error",
          "content": "No response for 90 seconds",
          "timestamp": 1700000000000,
          "code": "stream_stall",
          "timeoutMs": 90000,
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "message",
          "messageType": "error",
          "content": "Could not resume the previous conversation",
          "timestamp": 1700000000000,
          "code": "resume_unknown",
          "attemptedResumeId": "conv-123",
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "message",
          "messageType": "error",
          "content": "Something went wrong",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 3
        }
      ]
    },
    {
      "name": "system-markers",
      "description": "System rows: the compaction boundary, an MCP prompt expansion and a plain note.",
      "providers": [
        "claude-sdk"
      ],
      "events": [
        [
          "message",
          {
            "type": "system",
            "content": "Context compacted",
            "subtype": "compact_boundary",
            "compactMetadata": {
              "trigger": "auto",
              "preTokens": 180000,
              "postTokens": 24000,
              "durationMs": 5400
            },
            "timestamp": 1700000000100
          }
        ],
        [
          "message",
          {
            "type": "system",
            "content": "Expanded /mcp__docs__summarize",
            "subtype": "mcp_prompt_expansion",
            "mcpPromptExpansion": {
              "server": "docs",
              "prompt": "summarize",
              "text": "Summarize the repository layout.",
              "truncated": false
            },
            "timestamp": 1700000000200
          }
        ],
        [
          "message",
          {
            "type": "system",
            "content": "Session resumed",
            "timestamp": 1700000000300
          }
        ]
      ],
      "live": [
        {
          "type": "message",
          "messageType": "system",
          "content": "Context compacted",
          "timestamp": 1700000000100,
          "subtype": "compact_boundary",
          "compactMetadata": {
            "trigger": "auto",
            "preTokens": 180000,
            "postTokens": 24000,
            "durationMs": 5400
          },
          "sessionId": "s1"
        },
        {
          "type": "message",
          "messageType": "system",
          "content": "Expanded /mcp__docs__summarize",
          "timestamp": 1700000000200,
          "subtype": "mcp_prompt_expansion",
          "mcpPromptExpansion": {
            "server": "docs",
            "prompt": "summarize",
            "text": "Summarize the repository layout.",
            "truncated": false
          },
          "sessionId": "s1"
        },
        {
          "type": "message",
          "messageType": "system",
          "content": "Session resumed",
          "timestamp": 1700000000300,
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "message",
          "messageType": "system",
          "content": "Context compacted",
          "timestamp": 1700000000100,
          "subtype": "compact_boundary",
          "compactMetadata": {
            "trigger": "auto",
            "preTokens": 180000,
            "postTokens": 24000,
            "durationMs": 5400
          },
          "sessionId": "s1",
          "historySeq": 1
        },
        {
          "type": "message",
          "messageType": "system",
          "content": "Expanded /mcp__docs__summarize",
          "timestamp": 1700000000200,
          "subtype": "mcp_prompt_expansion",
          "mcpPromptExpansion": {
            "server": "docs",
            "prompt": "summarize",
            "text": "Summarize the repository layout.",
            "truncated": false
          },
          "sessionId": "s1",
          "historySeq": 2
        },
        {
          "type": "message",
          "messageType": "system",
          "content": "Session resumed",
          "timestamp": 1700000000300,
          "sessionId": "s1",
          "historySeq": 3
        }
      ]
    },
    {
      "name": "permission-allowed",
      "description": "A permission prompt that was answered (allow).",
      "providers": [
        "claude-sdk",
        "claude-tui"
      ],
      "events": [
        [
          "permission_request",
          {
            "requestId": "req-1",
            "tool": "Bash",
            "description": "rm -rf build",
            "input": {
              "command": "rm -rf build"
            },
            "remainingMs": 120000
          }
        ],
        [
          "permission_resolved",
          {
            "requestId": "req-1",
            "decision": "allow"
          }
        ],
        [
          "permission_outcome",
          {
            "requestId": "req-1",
            "tool": "Bash",
            "description": "rm -rf build",
            "outcome": "allowed"
          }
        ]
      ],
      "live": [
        {
          "type": "permission_request",
          "requestId": "req-1",
          "tool": "Bash",
          "description": "rm -rf build",
          "input": {
            "command": "rm -rf build"
          },
          "remainingMs": 120000,
          "floored": true,
          "sessionId": "s1"
        },
        {
          "type": "permission_resolved",
          "requestId": "req-1",
          "decision": "allow",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "permission_outcome",
          "requestId": "req-1",
          "tool": "Bash",
          "description": "rm -rf build",
          "outcome": "allowed",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        }
      ]
    },
    {
      "name": "permission-denied",
      "description": "A permission prompt that was answered (deny).",
      "providers": [
        "claude-sdk",
        "claude-tui"
      ],
      "events": [
        [
          "permission_request",
          {
            "requestId": "req-1",
            "tool": "Bash",
            "description": "rm -rf build",
            "input": {
              "command": "rm -rf build"
            },
            "remainingMs": 120000
          }
        ],
        [
          "permission_resolved",
          {
            "requestId": "req-1",
            "decision": "deny"
          }
        ],
        [
          "permission_outcome",
          {
            "requestId": "req-1",
            "tool": "Bash",
            "description": "rm -rf build",
            "outcome": "denied"
          }
        ]
      ],
      "live": [
        {
          "type": "permission_request",
          "requestId": "req-1",
          "tool": "Bash",
          "description": "rm -rf build",
          "input": {
            "command": "rm -rf build"
          },
          "remainingMs": 120000,
          "floored": true,
          "sessionId": "s1"
        },
        {
          "type": "permission_resolved",
          "requestId": "req-1",
          "decision": "deny",
          "sessionId": "s1"
        }
      ],
      "replay": [
        {
          "type": "permission_outcome",
          "requestId": "req-1",
          "tool": "Bash",
          "description": "rm -rf build",
          "outcome": "denied",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        }
      ]
    },
    {
      "name": "permission-expired",
      "description": "A permission prompt nobody answered before it expired.",
      "providers": [
        "claude-sdk",
        "claude-tui"
      ],
      "events": [
        [
          "permission_request",
          {
            "requestId": "req-1",
            "tool": "Bash",
            "description": "rm -rf build",
            "input": {
              "command": "rm -rf build"
            },
            "remainingMs": 120000
          }
        ],
        [
          "permission_expired",
          {
            "requestId": "req-1",
            "message": "This permission request expired"
          }
        ],
        [
          "permission_outcome",
          {
            "requestId": "req-1",
            "tool": "Bash",
            "description": "rm -rf build",
            "outcome": "expired"
          }
        ]
      ],
      "live": [
        {
          "type": "permission_request",
          "requestId": "req-1",
          "tool": "Bash",
          "description": "rm -rf build",
          "input": {
            "command": "rm -rf build"
          },
          "remainingMs": 120000,
          "floored": true,
          "sessionId": "s1"
        },
        {
          "type": "permission_expired",
          "requestId": "req-1",
          "sessionId": "s1",
          "message": "This permission request expired"
        }
      ],
      "replay": [
        {
          "type": "permission_outcome",
          "requestId": "req-1",
          "tool": "Bash",
          "description": "rm -rf build",
          "outcome": "expired",
          "timestamp": 1700000000000,
          "sessionId": "s1",
          "historySeq": 1
        }
      ]
    }
  ]
} /* json:end */
