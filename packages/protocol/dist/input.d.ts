import type { Attachment, InputContextEnvelope, InputMessage } from './schemas/client.ts';
export interface BuildInputMessageOptions {
    input: string;
    clientMessageId?: string;
    sessionId?: string | null;
    attachments?: Attachment[];
    context?: InputContextEnvelope;
    isVoice?: boolean;
}
/** Canonical app/dashboard serializer for the client input wire contract. */
export declare function buildInputMessage(options: BuildInputMessageOptions): InputMessage;
