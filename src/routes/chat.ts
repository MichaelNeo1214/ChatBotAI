import { Router } from 'express';
import {
  addMessage,
  createConversation,
  getConversation,
  listMessages,
  renameConversation,
  titleFromMessage,
} from '../db/conversations.ts';
import { badRequest, notFound } from '../middleware/errors.ts';
import { resolveProviderForRequest, type ChatMessage } from '../providers/index.ts';

export const chatRouter = Router();

const MAX_MESSAGE_LENGTH = 32_000;
/** How much prior conversation to replay to the model. */
const HISTORY_LIMIT = 40;

/**
 * POST /api/chat
 *
 * Body: { message: string, conversationId?: string, model?: string }
 * Responds with Server-Sent Events:
 *   event: meta   — { conversationId, messageId } (sent before any token)
 *   event: delta  — { text } for each chunk
 *   event: done   — { messageId, content }
 *   event: error  — { message }
 */
chatRouter.post('/', async (req, res, next) => {
  try {
    const { message, conversationId, model } = req.body ?? {};

    if (typeof message !== 'string' || message.trim() === '') {
      throw badRequest('"message" is required and must be a non-empty string');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw badRequest(`"message" must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }
    // A client that has not started a conversation may send null or omit the key.
    if (conversationId != null && typeof conversationId !== 'string') {
      throw badRequest('"conversationId" must be a string when provided');
    }
    if (model != null && typeof model !== 'string') {
      throw badRequest('"model" must be a string when provided');
    }

    const text = message.trim();

    // Resolved before anything is written, so a bad model or a missing key
    // fails as a normal JSON 400 instead of mid-stream.
    const { provider: chatProvider, model: resolvedModel } = resolveProviderForRequest({
      modelLabel: model,
      headers: req.headers,
    });

    const conversation = conversationId
      ? getConversation(conversationId, req.ownerId)
      : createConversation(req.ownerId, { title: titleFromMessage(text), model });

    if (!conversation) throw notFound('Conversation not found');

    // The history the model sees must not include the new message twice.
    const history: ChatMessage[] = listMessages(conversation.id)
      .filter((row) => row.role !== 'system')
      .slice(-HISTORY_LIMIT)
      .map((row) => ({ role: row.role as ChatMessage['role'], content: row.content }));

    addMessage(conversation.id, 'user', text);

    // First real message in a conversation that was created empty: name it.
    if (history.length === 0 && conversation.title === 'New chat') {
      renameConversation(conversation.id, req.ownerId, titleFromMessage(text));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('meta', { conversationId: conversation.id, model: conversation.model });

    // Stop generating if the browser navigates away or hits stop.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let answer = '';
    try {
      for await (const chunk of chatProvider.streamChat({
        messages: [...history, { role: 'user', content: text }],
        model: resolvedModel,
        signal: abort.signal,
      })) {
        answer += chunk;
        send('delta', { text: chunk });
      }
    } catch (streamError) {
      // Persist whatever arrived before the failure so the turn is not lost.
      if (answer !== '') addMessage(conversation.id, 'assistant', answer);
      if (!abort.signal.aborted) {
        console.error('[chat] provider stream failed', streamError);
        send('error', { message: 'The assistant failed to finish this response.' });
      }
      res.end();
      return;
    }

    const saved = addMessage(conversation.id, 'assistant', answer);
    send('done', { messageId: saved.id, content: answer });
    res.end();
  } catch (error) {
    next(error);
  }
});
