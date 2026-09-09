import { Router } from 'express';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
} from '../db/conversations.ts';
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
  res.status(201).json({ conversation: createConversation(req.ownerId, { title, model }) });
});

conversationsRouter.get('/:id', (req, res) => {
  const conversation = getConversation(req.params.id, req.ownerId);
  if (!conversation) throw notFound('Conversation not found');
  res.json({ conversation, messages: listMessages(conversation.id) });
});

conversationsRouter.patch('/:id', (req, res) => {
  const { title } = req.body ?? {};
  if (typeof title !== 'string' || title.trim() === '') {
    throw badRequest('"title" is required and must be a non-empty string');
  }
  if (!renameConversation(req.params.id, req.ownerId, title.trim())) {
    throw notFound('Conversation not found');
  }
  res.json({ conversation: getConversation(req.params.id, req.ownerId) });
});

conversationsRouter.delete('/:id', (req, res) => {
  if (!deleteConversation(req.params.id, req.ownerId)) {
    throw notFound('Conversation not found');
  }
  res.status(204).end();
});
