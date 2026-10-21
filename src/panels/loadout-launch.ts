import "./loadout-launch.css";

// Rows only. Agent and Model are omitted: the tab header already carries both.
export function launchPresentation(facts: [string, string][]): HTMLElement {
  const root = document.createElement("div");
  root.className = "loadout-launch";
  const content = document.createElement("dl");
  content.className = "launch-facts";
  for (const [label, value] of facts) {
    const row = document.createElement("div");
    const key = document.createElement("dt");
    const val = document.createElement("dd");
    key.textContent = label;
    val.textContent = value;
    row.append(key, val);
    content.append(row);
  }
  root.append(content);
  return root;
}
