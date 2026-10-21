// Form-mode MCP elicitation fields. Values are collected only for the user's Allow action;
// the adapter validates the same schema again before sending them to Codex.
import { el } from "./dom";
import { DRIVE_CLASS } from "../rendered-drive";

type Json = Record<string, unknown>;
type Field = { name: string; read: () => unknown; valid: () => boolean };
const obj = (v: unknown): Json | null => v && typeof v === "object" && !Array.isArray(v) ? v as Json : null;
const str = (v: unknown): string => typeof v === "string" ? v : "";
const options = (spec: Json): unknown[] | null => {
  if (Array.isArray(spec.enum)) return spec.enum;
  if (Array.isArray(spec.oneOf)) return spec.oneOf.map((item) => obj(item)?.const);
  return null;
};
const arrayOptions = (spec: Json): unknown[] | null => {
  const item = obj(spec.items);
  if (Array.isArray(item?.enum)) return item.enum;
  if (Array.isArray(item?.anyOf)) return item.anyOf.map((entry) => obj(entry)?.const);
  return null;
};
function validValue(spec: Json, value: unknown): boolean {
  const choices = spec.type === "array" ? arrayOptions(spec) : options(spec);
  if (choices) return spec.type === "array"
    ? Array.isArray(value) && value.length >= (typeof spec.minItems === "number" ? spec.minItems : 0)
      && value.length <= (typeof spec.maxItems === "number" ? spec.maxItems : Infinity)
      && value.every((v) => choices.includes(v))
    : choices.includes(value);
  if (spec.type === "string") return typeof value === "string"
    && value.length >= (typeof spec.minLength === "number" ? spec.minLength : 0)
    && value.length <= (typeof spec.maxLength === "number" ? spec.maxLength : Infinity);
  if (spec.type === "boolean") return typeof value === "boolean";
  if (spec.type === "number" || spec.type === "integer") return typeof value === "number"
    && Number.isFinite(value) && (spec.type !== "integer" || Number.isInteger(value))
    && value >= (typeof spec.minimum === "number" ? spec.minimum : -Infinity)
    && value <= (typeof spec.maximum === "number" ? spec.maximum : Infinity);
  return false;
}

export function mcpElicitationForm(body: HTMLElement, input: unknown, onChange: (valid: boolean) => void) {
  const schema = obj(obj(input)?.requestedSchema);
  const properties = obj(schema?.properties);
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((v): v is string => typeof v === "string") : []);
  const fields: Field[] = [];
  const secrets: HTMLInputElement[] = [];
  let supported = !!schema && !!properties && schema.type === "object";
  const changed = () => onChange(answered());

  if (properties) for (const [name, raw] of Object.entries(properties)) {
    const spec = obj(raw);
    const title = str(spec?.title) || name;
    const row = el("label", "mcp-field");
    row.appendChild(el("span", "mcp-field-name", `${title}${required.has(name) ? " *" : ""}`));
    if (str(spec?.description)) row.appendChild(el("span", "mcp-field-help", str(spec?.description)));
    let read: (() => unknown) | null = null;
    let hasValue = () => false;
    const choices = spec ? options(spec) : null;
    if (choices && choices.every((v) => typeof v === "string" || typeof v === "number")) {
      const select = el("select", "mcp-field-input");
      const placeholder = el("option", "", "Choose"); placeholder.value = ""; select.appendChild(placeholder);
      choices.forEach((v, index) => { const option = el("option", "", String(v)); option.value = String(index); select.appendChild(option); });
      select.addEventListener("change", changed);
      row.appendChild(select);
      read = () => select.value === "" ? undefined : choices[Number(select.value)];
      hasValue = () => select.value !== "";
    } else if (spec?.type === "string") {
      const field = el("input", "mcp-field-input");
      field.type = spec.format === "password" ? "password" : "text";
      if (field.type === "password") secrets.push(field);
      field.addEventListener("input", changed);
      row.appendChild(field);
      read = () => field.value === "" ? undefined : field.value;
      hasValue = () => field.value !== "";
    } else if (spec?.type === "integer" || spec?.type === "number") {
      const field = el("input", "mcp-field-input");
      field.type = "number";
      field.step = spec.type === "integer" ? "1" : "any";
      field.addEventListener("input", changed);
      row.appendChild(field);
      read = () => field.value.trim() === "" || !field.validity.valid ? undefined : Number(field.value);
      hasValue = () => field.value.trim() !== "";
    } else if (spec?.type === "boolean") {
      const select = el("select", "mcp-field-input");
      for (const [value, label] of [["", "Choose"], ["true", "Yes"], ["false", "No"]]) {
        const option = el("option", "", label); option.value = value; select.appendChild(option);
      }
      select.addEventListener("change", changed);
      row.appendChild(select);
      read = () => select.value === "" ? undefined : select.value === "true";
      hasValue = () => select.value !== "";
    } else if (spec?.type === "array" && arrayOptions(spec)?.every((v) => typeof v === "string")) {
      const choices = arrayOptions(spec) as string[];
      const boxes = choices.map((choice) => {
        const line = el("label", "mcp-field-choice");
        const box = el("input"); box.type = "checkbox"; box.addEventListener("change", changed);
        line.append(box, el("span", "", choice)); row.appendChild(line);
        return { choice, box };
      });
      read = () => { const picked = boxes.filter((b) => b.box.checked).map((b) => b.choice); return picked.length ? picked : undefined; };
      hasValue = () => boxes.some((b) => b.box.checked);
    }
    if (!spec || !read) {
      supported = false;
      row.appendChild(el("span", "mcp-field-help", "This Field Cannot Be Answered In Vidar"));
    } else {
      fields.push({ name, read, valid: () => (!required.has(name) || hasValue())
        && (!hasValue() || validValue(spec, read())) });
    }
    body.appendChild(row);
  }
  if (!supported) body.appendChild(el("div", "tool-input", "This Form Cannot Be Approved In Vidar"));
  if (secrets.length) {
    const root = body.parentElement ?? body;
    const watch = new MutationObserver(() => {
      if (!root.classList.contains(DRIVE_CLASS.settled)) return;
      for (const field of secrets) field.value = "";
      watch.disconnect();
    });
    watch.observe(root, { attributes: true, attributeFilter: ["class"] });
  }
  function answered() { return supported && [...required].every((name) => fields.some((f) => f.name === name)) && fields.every((f) => f.valid()); }
  return {
    answered,
    collect: () => ({ content: Object.fromEntries(fields.map((f) => [f.name, f.read()]).filter(([, value]) => value !== undefined)) }),
  };
}
