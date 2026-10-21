// skills/list catalog -> the shared slash palette and explicit app-server skill input.
type Skill = { name: string; path: string };

export class CodexSkills {
  private rows = new Map<string, Skill>();
  get commands(): string[] { return [...this.rows.keys()]; }

  catalog(data: unknown): string[] {
    this.rows.clear();
    if (Array.isArray(data)) for (const entry of data) {
      if (!Array.isArray(entry?.skills)) continue;
      for (const skill of entry.skills) {
        if (skill?.enabled !== true || typeof skill.name !== "string" || !skill.name ||
            typeof skill.path !== "string" || !skill.path || this.rows.has(skill.name)) continue;
        this.rows.set(skill.name, { name: skill.name, path: skill.path });
      }
    }
    return this.commands;
  }

  input(text: string): Record<string, unknown>[] {
    const name = /^\/([^\s]+)(?:\s|$)/.exec(text)?.[1];
    const skill = name ? this.rows.get(name) : undefined;
    return [{ type: "text", text }, ...(skill ? [{ type: "skill", ...skill }] : [])];
  }
}
