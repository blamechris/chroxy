/**
 * Server → Client schemas for the IDE navigation surface (epic #6469).
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). The whole surface is gated behind the opt-in
 * `features.ide` flag (#6481) — the server advertises the `ide` capability and
 * emits these messages only when the operator opts in.
 *
 * v1 is DASHBOARD_ONLY (the mobile app has no symbol surface yet); the asymmetry
 * is declared in the protocol type-coverage lint (DASHBOARD_ONLY) and the
 * handler-coverage guard (PLATFORM_SPECIFIC: 'dashboard').
 */
import { z } from 'zod';
export declare const SymbolEntrySchema: z.ZodObject<{
    name: z.ZodString;
    kind: z.ZodString;
    file: z.ZodString;
    line: z.ZodNumber;
    exported: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerSymbolsSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"symbols_snapshot">;
    path: z.ZodNullable<z.ZodString>;
    symbols: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        kind: z.ZodString;
        file: z.ZodString;
        line: z.ZodNumber;
        exported: z.ZodBoolean;
    }, z.core.$strip>>;
    truncated: z.ZodBoolean;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type SymbolEntry = z.infer<typeof SymbolEntrySchema>;
export type ServerSymbolsSnapshotMessage = z.infer<typeof ServerSymbolsSnapshotSchema>;
export declare const ServerSymbolLocationSchema: z.ZodObject<{
    type: z.ZodLiteral<"symbol_location">;
    symbol: z.ZodString;
    file: z.ZodNullable<z.ZodString>;
    line: z.ZodNullable<z.ZodNumber>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type ServerSymbolLocationMessage = z.infer<typeof ServerSymbolLocationSchema>;
export declare const SearchResultEntrySchema: z.ZodObject<{
    file: z.ZodString;
    line: z.ZodNumber;
    column: z.ZodNumber;
    text: z.ZodString;
}, z.core.$strip>;
export declare const ServerSearchResultsSchema: z.ZodObject<{
    type: z.ZodLiteral<"code_search_results">;
    query: z.ZodString;
    results: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        column: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>>;
    truncated: z.ZodBoolean;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type SearchResultEntry = z.infer<typeof SearchResultEntrySchema>;
export type ServerSearchResultsMessage = z.infer<typeof ServerSearchResultsSchema>;
