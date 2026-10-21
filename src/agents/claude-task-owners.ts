// Which background tasks a subagent started, and which subagent (split from claude.ts). A
// subagent's own tool call carries parent_tool_use_id = the Agent call that launched it; its
// task_started names that call in tool_use_id, so the task resolves to the owning agent row, and
// agents-block.ts liveTasks parks only that row on it (review-fix C1). An owner that does not
// resolve (no tool_use_id, a call never seen) is left out: the row side then parks as before.

/** Only a background call's entry is ever read, soon after the call: older ones are dropped. */
const MAX_CALLS = 2000;

export class TaskOwners {
  /** background task ids a subagent started (task_started owned_by_subagent), until they end */
  private owned = new Set<string>();
  /** a subagent's tool call -> its parent_tool_use_id */
  private callParent = new Map<string, string>();
  /** subagent-owned task id -> the owning Agent call's tool_use_id */
  private owner = new Map<string, string>();

  /** a tool_use block in a message with parent_tool_use_id set */
  noteCall(call: string, parent: string): void {
    this.callParent.set(call, parent);
    if (this.callParent.size > MAX_CALLS) this.callParent.delete(this.callParent.keys().next().value!);
  }
  /** task_started with owned_by_subagent, not ambient; `call` is its tool_use_id when sent */
  started(taskId: string, call: string): void {
    this.owned.add(taskId);
    const parent = call ? this.callParent.get(call) : undefined;
    if (parent) this.owner.set(taskId, parent);
    if (call) this.callParent.delete(call);
  }
  /** task_notification: the task ended */
  ended(taskId: string): void {
    this.owned.delete(taskId);
    this.owner.delete(taskId);
  }
  /** a live set's subagent-owned subset, and the owners of those that resolved */
  live(ids: readonly string[]): { subagentOwned: string[]; subagentOwners?: Record<string, string> } {
    const subagentOwned = ids.filter((id) => this.owned.has(id));
    const owners: Record<string, string> = {};
    for (const id of subagentOwned) { const o = this.owner.get(id); if (o) owners[id] = o; }
    return Object.keys(owners).length ? { subagentOwned, subagentOwners: owners } : { subagentOwned };
  }
}
