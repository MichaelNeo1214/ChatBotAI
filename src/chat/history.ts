import type { MessageRow } from '../db/index.ts';
import type { ChatMessage } from '../providers/types.ts';

export interface HistoryOptions {
  /**
   * Total characters the replayed history may occupy, including the new
   * message. Characters are a provider-neutral stand-in for tokens: roughly
   * four per token for English, fewer for code and non-Latin scripts, so the
   * budget is deliberately conservative.
   */
  budgetChars: number;
}

/**
 * Picks the slice of a conversation to replay to the model before a new
 * user message.
 *
 * Newest turns are kept and older ones dropped once the budget is spent, so a
 * long conversation still fits the model's context window rather than
 * failing with a provider error. The new message is always sent even when it
 * alone exceeds the budget, so a single oversized message can never block a
 * turn.
 *
 * System rows are skipped: each adapter injects its own system prompt.
 * The slice is trimmed to start on a user turn because some providers reject
 * a history that opens with an assistant message.
 */
export function selectHistory(
  rows: readonly MessageRow[],
  newMessage: string,
  options: HistoryOptions,
): ChatMessage[] {
  let remaining = options.budgetChars - newMessage.length;
  const kept: ChatMessage[] = [];

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.role === 'system') continue;
    if (row.content.length > remaining) break;
    remaining -= row.content.length;
    kept.push({ role: row.role, content: row.content });
  }
  kept.reverse();

  const firstUser = kept.findIndex((message) => message.role === 'user');
  return firstUser === -1 ? [] : kept.slice(firstUser);
}
