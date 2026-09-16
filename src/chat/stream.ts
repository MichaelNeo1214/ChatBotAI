import type { Response } from 'express';
import { addMessage } from '../db/conversations.ts';
import type { ConversationRow, MessageRow } from '../db/index.ts';
import type { ChatMessage, ChatProvider } from '../providers/types.ts';

export interface StreamTurnOptions {
  res: Response;
  conversation: ConversationRow;
  provider: ChatProvider;
  /** Model id the adapter should send upstream. */
  model: string;
  /** Everything the model sees, ending with the user turn being answered. */
  messages: ChatMessage[];
  /** Extra fields for the `meta` event beyond conversationId and model. */
  meta?: Record<string, unknown>;
}

/**
 * Streams one assistant reply as Server-Sent Events and stores it.
 *
 *   event: meta   — { conversationId, model, ...meta } before any token
 *   event: delta  — { text } per chunk
 *   event: done   — { messageId, content }
 *   event: error  — { message } in place of done when the provider fails
 *
 * Nothing here validates input or checks ownership; the caller has already
 * done that and written any user message. This only owns the part that is the
 * same for a new turn and a regenerated one: the SSE framing, abort on
 * disconnect, and saving whatever arrived even when the stream fails.
 */
export async function streamAssistantReply(options: StreamTurnOptions): Promise<MessageRow | null> {
  const { res, conversation, provider, model, messages, meta } = options;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('meta', { conversationId: conversation.id, model: conversation.model, ...meta });

  // Stop generating if the browser navigates away or hits stop.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let answer = '';
  try {
    for await (const chunk of provider.streamChat({
      messages,
      model,
      system: conversation.system_prompt ?? undefined,
      signal: abort.signal,
    })) {
      answer += chunk;
      send('delta', { text: chunk });
    }
  } catch (streamError) {
    // Persist whatever arrived before the failure so the turn is not lost.
    const partial = answer !== '' ? addMessage(conversation.id, 'assistant', answer) : null;
    if (!abort.signal.aborted) {
      console.error('[chat] provider stream failed', streamError);
      send('error', { message: 'The assistant failed to finish this response.' });
    }
    res.end();
    return partial;
  }

  const saved = addMessage(conversation.id, 'assistant', answer);
  send('done', { messageId: saved.id, content: answer });
  res.end();
  return saved;
}
