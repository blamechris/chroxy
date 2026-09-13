/** Canonical app/dashboard serializer for the client input wire contract. */
export function buildInputMessage(options) {
    if (options.context && !options.clientMessageId) {
        throw new Error('clientMessageId is required for selected context delivery');
    }
    return {
        type: 'input',
        data: options.input,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        ...(options.isVoice ? { isVoice: true } : {}),
        ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
        ...(options.context ? { context: options.context } : {}),
    };
}
