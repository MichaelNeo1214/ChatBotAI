import { randomUUID } from 'crypto';

app.use((req, res, next) => {
  let ownerId = req.cookies.owner_id;
  if (!ownerId) {
    ownerId = randomUUID();
    res.cookie('owner_id', ownerId, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 365 });
  }
  req.ownerId = ownerId;
  next();
});

// POST /api/conversations  -> new chat
app.post('/api/conversations', (req, res) => {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO conversations (id, owner_id, title, model)
    VALUES (?, ?, 'New chat', ?)
  `).run(id, req.ownerId, req.body.model ?? 'ChatBot AI');
  res.json({ id, title: 'New chat' });
});

// GET /api/conversations -> render sidebar
app.get('/api/conversations', (req, res) => {
  const rows = db.prepare(`
    SELECT id, title, updated_at FROM conversations
    WHERE owner_id = ? ORDER BY updated_at DESC
  `).all(req.ownerId);
  res.json(rows);
});

// GET /api/conversations/:id/messages -> load chat saat diklik
app.get('/api/conversations/:id/messages', (req, res) => {
  const rows = db.prepare(`
    SELECT role, content, created_at FROM messages
    WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(req.params.id);
  res.json(rows);
});

// PATCH /api/conversations/:id -> rename
app.patch('/api/conversations/:id', (req, res) => {
  db.prepare(`
    UPDATE conversations SET title = ?, updated_at = datetime('now')
    WHERE id = ? AND owner_id = ?
  `).run(req.body.title, req.params.id, req.ownerId);
  res.json({ ok: true });
});

// DELETE /api/conversations/:id -> hapus (messages ikut kehapus via CASCADE)
app.delete('/api/conversations/:id', (req, res) => {
  db.prepare(`DELETE FROM conversations WHERE id = ? AND owner_id = ?`)
    .run(req.params.id, req.ownerId);
  res.json({ ok: true });
});

db.prepare(`
  INSERT INTO messages (id, conversation_id, role, content)
  VALUES (?, ?, 'user', ?)
`).run(randomUUID(), conversationId, userMessage);

// ...panggil JAN, dapat reply...

db.prepare(`
  INSERT INTO messages (id, conversation_id, role, content)
  VALUES (?, ?, 'assistant', ?)
`).run(randomUUID(), conversationId, replyText);

db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`)
  .run(conversationId);