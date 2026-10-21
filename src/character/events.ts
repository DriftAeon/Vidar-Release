export interface CharacterStatusDetail {
  id: string;
  model: string | null;
  contextUsedPercentage: number | null;
  fresh: boolean;
}

export interface CharacterActivityDetail {
  id: string;
  active: boolean;
}

export interface CharacterCompletionDetail {
  id: string;
}

export function dispatchCharacterStatus(detail: CharacterStatusDetail): void {
  document.dispatchEvent(new CustomEvent("vidar-character-status", { detail }));
}

export function dispatchCharacterActivity(detail: CharacterActivityDetail): void {
  document.dispatchEvent(new CustomEvent("vidar-character-activity", { detail }));
}

export function dispatchCharacterCompletion(detail: CharacterCompletionDetail): void {
  document.dispatchEvent(new CustomEvent("vidar-character-completion", { detail }));
}
