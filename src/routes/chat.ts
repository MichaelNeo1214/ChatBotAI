import { Router } from 'express';
import { selectHistory } from '../chat/history.ts';
import { readSystemPrompt } from '../chat/personalities.ts';
import { config } from '../config.ts';
import {
  addMessage,
  createConversation,
  getConversation,
  listMessages,
  renameConversation,
  titleFromMessage,
} from '../db/conversations.ts';
import { badRequest, notFound } from '../middleware/errors.ts';
import { rateLimit } from '../middleware/rate-limit.ts';
import { resolveProviderForRequest } from '../providers/index.ts';

export const chatRouter = Router();

const MAX_MESSAGE_LENGTH = 32_000;

const RATE_LIMITED = {
  code: 'rate_limited',
  message: 'You are sending messages too quickly. Please wait a moment.',
};

// Owner first so a browser that hits its own cap does not also eat into the
// shared per-IP budget of everyone behind the same NAT.
const ownerLimiter = rateLimit({
  ...RATE_LIMITED,
  windowMs: config.chatRateLimit.windowMs,
  max: config.chatRateLimit.perOwner,
  key: (req) => `owner:${req.ownerId}`,
});
const ipLimiter = rateLimit({
  ...RATE_LIMITED,
  windowMs: config.chatRateLimit.windowMs,
  max: config.chatRateLimit.perIp,
  key: (req) => `ip:${req.ip ?? 'unknown'}`,
});

/**
 * POST /api/chat
 *
 * Body: { message: string, conversationId?: string, model?: string,
 *         systemPrompt?: string, personality?: string }
 * The persona fields apply only when this turn starts a new conversation;
 * an existing one is changed with PATCH /api/conversations/:id.
 * Responds with Server-Sent Events:
 *   event: meta   — { conversationId, messageId } (sent before any token)
 *   event: delta  — { text } for each chunk
 *   event: done   — { messageId, content }
 *   event: error  — { message }
 *
 * Over the limit: 429 { error: { code: "rate_limited", retryAfter } } with a
 * Retry-After header, before anything is written.
 */
chatRouter.post('/', ownerLimiter, ipLimiter, async (req, res, next) => {
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

    const systemPrompt = readSystemPrompt(req.body);
    if (systemPrompt !== undefined && conversationId) {
      throw badRequest(
        'Change the persona of an existing conversation with PATCH /api/conversations/:id',
        { code: 'persona_on_existing_conversation' },
      );
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
      : createConversation(req.ownerId, { title: titleFromMessage(text), model, systemPrompt });

    if (!conversation) throw notFound('Conversation not found');

    // Read before the new message is stored so it is not replayed twice.
    const stored = listMessages(conversation.id);
    const history = selectHistory(stored, text, { budgetChars: config.chatContextChars });

    addMessage(conversation.id, 'user', text);

    // First real message in a conversation that was created empty: name it.
    if (stored.length === 0 && conversation.title === 'New chat') {
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
        system: conversation.system_prompt ?? undefined,
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
