export interface ScreenContext {
  params: Record<string, string>;   // from the route pattern, e.g. { code: 'K7PQ2' }
  query: URLSearchParams;           // after '?' in the hash
  navigate(hash: string): void;
}
export interface Screen { mount(root: HTMLElement, ctx: ScreenContext): void; unmount(): void }
export type ScreenFactory = () => Screen;
const registry = new Map<string, ScreenFactory>();
/** pattern: '#/', '#/play', '#/room/:code' ... Called at module import by every *.screen.ts file. */
export function registerScreen(pattern: string, factory: ScreenFactory): void { registry.set(pattern, factory); }
export function getScreenRegistry(): ReadonlyMap<string, ScreenFactory> { return registry; }
