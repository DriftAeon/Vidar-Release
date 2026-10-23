// The stage slot of the Character window: what sits behind the character. The built-in
// default is the home sphere (home-sphere.ts `defaultStage`); a stage pack (stage-pack.ts)
// builds one from `content\stages\<id>\stage.json`. The arena owns the active stage and reads
// its camera far bound and orbit clamp from here instead of the dome's own constants.
import type * as T from "three";

export interface StageOrbit {
  minPolarAngle: number;
  maxPolarAngle: number;
  maxDistance: number;
  /** Absent: the character's framing decides (a fraction of its bounding radius). */
  minDistance?: number;
}

export interface Stage {
  /** The camera's far plane is never below this, so the stage is never clipped. */
  far: number;
  orbit: StageOrbit;
  /** Advances stage animation; called only from the existing render paths (no own RAF). */
  tick?(elapsedSeconds: number): void;
  /** `pixelHeight` is the drawing buffer height in device pixels. */
  resize?(pixelHeight: number, verticalFovDegrees: number): void;
  /** Removes everything the stage added to the scene and frees it. */
  dispose(): void;
}

export interface StageFactory {
  create(scene: T.Scene): Stage;
  /** Frees what the factory preloaded when `create` is never called (a superseded load). */
  discard?(): void;
}
