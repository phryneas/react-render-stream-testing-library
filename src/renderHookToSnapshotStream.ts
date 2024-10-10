import { RenderHookOptions } from "@testing-library/react";
import {
  createRenderStream,
  NextRenderOptions,
  ValidSnapshot,
} from "./profile/profile.js";
import { Render } from "./profile/Render.js";
import { createElement } from "react";
import { Assertable, assertableSymbol, markAssertable } from "./assertable.js";

export interface SnapshotStream<Snapshot extends ValidSnapshot, Props>
  extends Assertable {
  /**
   * An array of all renders that have happened so far.
   * Errors thrown during component render will be captured here, too.
   */
  renders: Array<
    Render<Snapshot> | { phase: "snapshotError"; count: number; error: unknown }
  >;
  /**
   * Peeks the next render from the current iterator position, without advancing the iterator.
   * If no render has happened yet, it will wait for the next render to happen.
   * @throws {WaitForRenderTimeoutError} if no render happens within the timeout
   */
  peekSnapshot(options?: NextRenderOptions): Promise<Snapshot>;
  /**
   * Iterates to the next render and returns it.
   * If no render has happened yet, it will wait for the next render to happen.
   * @throws {WaitForRenderTimeoutError} if no render happens within the timeout
   */
  takeSnapshot: Assertable &
    ((options?: NextRenderOptions) => Promise<Snapshot>);
  /**
   * Returns the total number of renders.
   */
  totalSnapshotCount(): number;
  /**
   * Returns the current render.
   * @throws {Error} if no render has happened yet
   */
  getCurrentSnapshot(): Snapshot;
  /**
   * Waits for the next render to happen.
   * Does not advance the render iterator.
   */
  waitForNextSnapshot(options?: NextRenderOptions): Promise<Snapshot>;
  rerender: (rerenderCallbackProps: Props) => void;
  unmount: () => void;
}

export function renderHookToSnapshotStream<
  ReturnValue extends ValidSnapshot,
  Props extends {},
>(
  renderCallback: (props: Props) => ReturnValue,
  { initialProps, ...options }: RenderHookOptions<Props> = {}
): SnapshotStream<ReturnValue, Props> {
  const { render, ...stream } = createRenderStream<ReturnValue>();

  const ProfiledHook: React.FC<Props> = (props) => {
    stream.replaceSnapshot(renderCallback(props));
    return null;
  };

  const { rerender: baseRerender, unmount } = render(
    createElement(ProfiledHook, initialProps),
    options
  );

  function rerender(rerenderCallbackProps: Props) {
    return baseRerender(createElement(ProfiledHook, rerenderCallbackProps));
  }

  return {
    [assertableSymbol]: stream,
    renders: stream.renders,
    totalSnapshotCount: stream.totalRenderCount,
    async peekSnapshot(options) {
      return (await stream.peekRender(options)).snapshot;
    },
    takeSnapshot: markAssertable(async function takeSnapshot(options) {
      return (await stream.takeRender(options)).snapshot;
    }, stream),
    getCurrentSnapshot() {
      return stream.getCurrentRender().snapshot;
    },
    async waitForNextSnapshot(options) {
      return (await stream.waitForNextRender(options)).snapshot;
    },
    rerender,
    unmount,
  };
}
