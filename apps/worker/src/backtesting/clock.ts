export interface Clock {
  now(): Date;
}
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
export class SimulationClock implements Clock {
  private time: number;
  constructor(start: string) {
    this.time = Date.parse(start);
    if (!Number.isFinite(this.time))
      throw new Error('Invalid simulation start');
  }
  now(): Date {
    return new Date(this.time);
  }
  advance(to: string | number): void {
    const next = typeof to === 'number' ? to : Date.parse(to);
    if (!Number.isFinite(next) || next < this.time)
      throw new Error('Simulation clock cannot move backwards');
    this.time = next;
  }
}
