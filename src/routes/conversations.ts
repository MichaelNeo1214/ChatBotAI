import { Router } from 'express';
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
  setSystemPrompt,
} from '../db/conversations.ts';
import { readSystemPrompt } from '../chat/personalities.ts';
import { badRequest, notFound } from '../middleware/errors.ts';

export const conversationsRouter = Router();

conversationsRouter.get('/', (req, res) => {
  res.json({ conversations: listConversations(req.ownerId) });
});

conversationsRouter.post('/', (req, res) => {
  const { title, model } = req.body ?? {};
  if (title != null && typeof title !== 'string') {
    throw badRequest('"title" must be a string when provided');
  }
  if (model != null && typeof model !== 'string') {
    throw badRequest('"model" must be a string when provided');
  }
  const systemPrompt = readSystemPrompt(req.body);
  res.status(201).json({
    conversation: createConversation(req.ownerId, { title, model, systemPrompt }),
  });
});

conversationsRouter.get('/:id', (req, res) => {
  const conversation = getConversation(req.params.id, req.ownerId);
  if (!conversation) throw notFound('Conversation not found');
  res.json({ conversation, messages: listMessages(conversation.id) });
});

/**
 * Updates any of: title, systemPrompt (free text, null to clear), personality
 * (a built-in id from GET /api/personalities). At least one is required.
 */
conversationsRouter.patch('/:id', (req, res) => {
  const { title } = req.body ?? {};
  const systemPrompt = readSystemPrompt(req.body);

  if (title === undefined && systemPrompt === undefined) {
    throw badRequest('Provide "title", "systemPrompt" or "personality"');
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    throw badRequest('"title" must be a non-empty string');
  }

  // Ownership is checked once up front so a partial update cannot leak whether
  // a conversation exists through a second, differently-scoped write.
  if (!getConversation(req.params.id, req.ownerId)) {
    throw notFound('Conversation not found');
  }
  if (title !== undefined) {
    renameConversation(req.params.id, req.ownerId, title.trim());
  }
  if (systemPrompt !== undefined) {
    setSystemPrompt(req.params.id, req.ownerId, systemPrompt);
  }
  res.json({ conversation: getConversation(req.params.id, req.ownerId) });
});

/** Removes one message. The conversation is looked up first so a foreign id is a 404, not a silent no-op. */
conversationsRouter.delete('/:id/messages/:messageId', (req, res) => {
  const conversation = getConversation(req.params.id, req.ownerId);
  if (!conversation) throw notFound('Conversation not found');
  if (!deleteMessage(conversation.id, req.params.messageId)) {
    throw notFound('Message not found');
  }
  res.status(204).end();
});

conversationsRouter.delete('/:id', (req, res) => {
  if (!deleteConversation(req.params.id, req.ownerId)) {
    throw notFound('Conversation not found');
  }
  res.status(204).end();
});
