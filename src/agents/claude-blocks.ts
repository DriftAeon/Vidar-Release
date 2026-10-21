// Block ids for the Claude adapter (claude.ts): which streamed block a complete `assistant`
// record lands on, and fresh ids for records the stream never opened. Ids are `m<n>:<index>`
// where n counts message spaces (a message_start, a replayed record, or a record of a message
// the stream did not open); subagent records get `sub:<parent>:<k>:<index>`, k never repeating.
// An id is never handed out twice: a text_done on a drawn block would overwrite it in place.

export type Streamed = { id: string; type: string };

/** thinking streams as `thinking` but may complete as `redacted_thinking`: one family */
const family = (type: string) => (type === "redacted_thinking" ? "thinking" : type);

export class BlockIds {
  private counter = 0;
  private subCounter = 0;
  /** stream block index → block id for the message currently streaming */
  private streaming: Map<number, Streamed> = new Map();
  /** streamed block ids already claimed by a complete `assistant` block */
  private claimed: Set<string> = new Set();
  /** every block id handed out in the current space, streamed or not */
  private issued: Set<string> = new Set();
  /** message.id of the message_start that opened the current space, if it named one */
  private streamMsgId: string | null = null;
  private extra = 0;

  /** A fresh id space: a message_start (with its message id) or a replayed record. Returns
   *  the previous space's streamed text and thinking blocks no complete record claimed (a
   *  stream abandoned mid-message, then retried): they will never complete, so the caller
   *  closes them (text_done "" removes a text block, thinking done settles a thought). */
  open(msgId: string | null): Streamed[] {
    const abandoned = [...this.streaming.values()].filter((b) => (b.type === "text" || b.type === "thinking") && !this.claimed.has(b.id));
    this.counter++;
    this.streaming.clear();
    this.claimed.clear();
    this.issued.clear();
    this.streamMsgId = msgId;
    return abandoned;
  }

  /** the turn's result: nothing streamed in it can still be completed */
  endTurn(): void {
    this.streaming.clear();
  }

  /** content_block_start: the streamed block's id */
  start(index: number, type: string): string {
    const id = `m${this.counter}:${index}`;
    this.streaming.set(index, { id, type });
    this.issued.add(id);
    return id;
  }

  streamed(index: number): Streamed | undefined {
    return this.streaming.get(index);
  }

  /** A top-level complete record. When it names a message other than the one the stream
   *  opened (a non-streaming retry after an abandoned stream, or an API error record), its
   *  blocks get a fresh space, and the streamed blocks that will never complete are
   *  returned for the caller to close, as open() does. */
  adopt(msgId: string): Streamed[] {
    if (!msgId || !this.streamMsgId || msgId === this.streamMsgId) return [];
    return this.open(msgId);
  }

  /** The streamed block a complete block resolves to. Claude Code 2.1.x emits one `assistant`
   *  record per content block (verified 2.1.263), so `content[index]` is always 0 and cannot be
   *  trusted as the stream index: match by type family instead, the first unclaimed streamed
   *  block. Nothing streamed (a whole-message shape, streaming off, an error record): the
   *  index, or a fresh id in the same space if that one is taken. The space itself is never
   *  cleared here: a block of this message may still be streaming. */
  resolve(type: string, index: number): string {
    for (const [, b] of this.streaming) {
      if (family(b.type) === family(type) && !this.claimed.has(b.id)) { this.claimed.add(b.id); return b.id; }
    }
    let id = `m${this.counter}:${index}`;
    while (this.issued.has(id)) id = `m${this.counter}:x${++this.extra}`;
    this.issued.add(id);
    return id;
  }

  /** a subagent record's id prefix: call once per record, never repeats */
  subRecord(parent: string): string {
    return `sub:${parent}:${++this.subCounter}`;
  }
}
