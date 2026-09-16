import { Router } from 'express';
import { selectHistory } from '../chat/history.ts';
import { readSystemPrompt } from '../chat/personalities.ts';
import { streamAssistantReply } from '../chat/stream.ts';
import { config } from '../config.ts';
import {
  addMessage,
  createConversation,
  deleteMessage,
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
 * Responds with the Server-Sent Events described in src/chat/stream.ts.
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

    await streamAssistantReply({
      res,
      conversation,
      provider: chatProvider,
      model: resolvedModel,
      messages: [...history, { role: 'user', content: text }],
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/chat/regenerate
 *
 * Body: { conversationId: string, model?: string }
 * Answers the conversation's last user message again. If the most recent
 * message is the assistant's reply it is deleted first, so the thread never
 * holds two answers to one question; the meta event names it as `replaced`.
 * A conversation whose last message is already the user's (an earlier reply
 * failed or was deleted) is simply answered. Same SSE stream as POST /api/chat.
 */
chatRouter.post('/regenerate', ownerLimiter, ipLimiter, async (req, res, next) => {
  try {
    const { conversationId, model } = req.body ?? {};

    if (typeof conversationId !== 'string' || conversationId === '') {
      throw badRequest('"conversationId" is required and must be a string');
    }
    if (model != null && typeof model !== 'string') {
      throw badRequest('"model" must be a string when provided');
    }

    const { provider: chatProvider, model: resolvedModel } = resolveProviderForRequest({
      modelLabel: model,
      headers: req.headers,
    });

    const conversation = getConversation(conversationId, req.ownerId);
    if (!conversation) throw notFound('Conversation not found');

    const stored = listMessages(conversation.id);
    const last = stored.at(-1);
    const replaced = last?.role === 'assistant' ? last : undefined;
    const rows = replaced ? stored.slice(0, -1) : stored;
    const target = rows.at(-1);

    if (!target || target.role !== 'user') {
      throw badRequest('There is no user message to answer', { code: 'nothing_to_regenerate' });
    }

    // Everything is decided before the delete so a bad request leaves the
    // thread untouched.
    if (replaced) deleteMessage(conversation.id, replaced.id);

    const history = selectHistory(rows.slice(0, -1), target.content, {
      budgetChars: config.chatContextChars,
    });

    await streamAssistantReply({
      res,
      conversation,
      provider: chatProvider,
      model: resolvedModel,
      messages: [...history, { role: 'user', content: target.content }],
      meta: { replaced: replaced?.id ?? null },
    });
  } catch (error) {
    next(error);
  }
});
