// The redaction rules live in @chroxy/protocol/redaction so the dashboard can share
// them (#9235). This file is the server's stable import path: it re-exports that one
// module instance, so `isSanitizedToolInput`'s WeakSet identity is never split in two.
export * from '@chroxy/protocol/redaction'
