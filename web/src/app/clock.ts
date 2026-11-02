// The day's clock (Tony, 2026-11-01; 5 s an hour, at his ask, after first trying 10). Unless
// time is frozen, each baked hour shows for HOUR_S seconds. After the last one the room goes
// dark for a NIGHT_S night (the bake only has the hours with the sun more than 5° up), then the
// day starts again at its first hour. Daylight fades over FADE_S seconds into the night and back
// out of it, starting the first hour.

export const HOUR_S = 5;
export const NIGHT_S = 10;
export const FADE_S = 1.5;

const ease = (t: number) => t * t * (3 - 2 * t);

/** Length of the day on the time bar, in hours: the baked hours, then the night. */
export const barHours = (nSlots: number) => nSlots + NIGHT_S / HOUR_S;

export class DayClock {
  /** False while time is frozen. */
  running = true;
  night = false;
  /** Seconds into the hour being shown, or into the night. */
  private t = 0;
  /** 1 by day, 0 at night; ramps between them over FADE_S. */
  private level = 1;

  /** Daylight for the lights: 1 by day, 0 at night, eased in between. */
  get daylight(): number {
    return ease(this.level);
  }

  /**
   * Where the time bar's thumb is, in hours from the first baked one: the hour shown plus how
   * far it has run, so it reaches the next hour's line as the clock moves on; after the last
   * hour, on into the night.
   */
  position(slot: number, nSlots: number): number {
    return (this.night ? nSlots : slot) + this.t / HOUR_S;
  }

  /** Show the current hour afresh (the visitor picked one, or unfroze time); ends a night. */
  restart(): void {
    this.t = 0;
    this.night = false;
  }

  /** Advance by dt seconds; returns the slot to move on to, or null to stay. */
  update(dt: number, slot: number, nSlots: number): number | null {
    const step = dt / FADE_S;
    this.level = this.night ? Math.max(0, this.level - step) : Math.min(1, this.level + step);
    if (!this.running) return null;
    this.t += dt;
    if (!this.night) {
      if (this.t < HOUR_S) return null;
      this.t -= HOUR_S;
      if (slot < nSlots - 1) return slot + 1;
      this.night = true;
      return null;
    }
    if (this.t < NIGHT_S) return null;
    this.t -= NIGHT_S;
    this.night = false;
    return 0;
  }
}
