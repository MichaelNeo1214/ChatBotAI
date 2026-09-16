import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageRow } from '../src/db/index.ts';
import { selectHistory } from '../src/chat/history.ts';

// Pure function, so no server, database or environment is needed here.

let counter = 0;
function row(role: MessageRow['role'], content: string): MessageRow {
  counter += 1;
  return {
    id: `m${counter}`,
    conversation_id: 'c1',
    role,
    content,
    created_at: `2026-01-01 00:00:${String(counter).padStart(2, '0')}.000`,
  };
}

const contents = (messages: { content: string }[]) => messages.map((m) => m.content);

describe('selectHistory', () => {
  test('replays everything when it fits', () => {
    const rows = [row('user', 'hi'), row('assistant', 'hello'), row('user', 'how are you')];
    const picked = selectHistory(rows, 'fine', { budgetChars: 1000 });
    assert.deepEqual(picked, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ]);
  });

  test('drops the oldest turns first once the budget is spent', () => {
    const rows = [
      row('user', 'aaaa'), // 4
      row('assistant', 'bbbb'), // 4
      row('user', 'cccc'), // 4
      row('assistant', 'dddd'), // 4
    ];
    // Budget 14 minus the 2-char new message leaves 12: the newest three fit,
    // then the leading assistant turn is trimmed so history opens with a user.
    const picked = selectHistory(rows, 'zz', { budgetChars: 14 });
    assert.deepEqual(contents(picked), ['cccc', 'dddd']);
  });

  test('the new message is charged against the budget', () => {
    const rows = [row('user', 'aaaa'), row('assistant', 'bbbb')];
    assert.equal(selectHistory(rows, 'x'.repeat(8), { budgetChars: 16 }).length, 2);
    assert.equal(selectHistory(rows, 'x'.repeat(9), { budgetChars: 16 }).length, 0);
  });

  test('an oversized new message yields empty history rather than failing', () => {
    const rows = [row('user', 'aaaa'), row('assistant', 'bbbb')];
    const picked = selectHistory(rows, 'x'.repeat(100), { budgetChars: 16 });
    assert.deepEqual(picked, []);
  });

  test('system rows are skipped and cost nothing', () => {
    const rows = [
      row('system', 'x'.repeat(500)),
      row('user', 'aaaa'),
      row('assistant', 'bbbb'),
    ];
    const picked = selectHistory(rows, 'zz', { budgetChars: 10 });
    assert.deepEqual(contents(picked), ['aaaa', 'bbbb']);
    assert.ok(picked.every((m) => m.role !== 'system'));
  });

  test('history never opens with an assistant turn', () => {
    const rows = [row('user', 'aaaa'), row('assistant', 'bbbb'), row('user', 'cc')];
    // 8 - 2 = 6 remaining: 'cc' (2) and 'bbbb' (4) fit, 'aaaa' does not.
    const picked = selectHistory(rows, 'zz', { budgetChars: 8 });
    assert.deepEqual(contents(picked), ['cc']);
  });

  test('a long conversation is not capped by message count', () => {
    const rows: MessageRow[] = [];
    for (let i = 0; i < 200; i += 1) {
      rows.push(row(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    }
    const picked = selectHistory(rows, 'next', { budgetChars: 100_000 });
    assert.equal(picked.length, 200);
    assert.equal(picked[0]?.content, 'm0');
    assert.equal(picked.at(-1)?.content, 'm199');
  });

  test('empty conversation gives empty history', () => {
    assert.deepEqual(selectHistory([], 'hello', { budgetChars: 100 }), []);
  });
});
