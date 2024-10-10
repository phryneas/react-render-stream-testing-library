import * as React from "rehackt";

import type { Render, BaseRender } from "./Render.js";
import { RenderInstance } from "./Render.js";
import { applyStackTrace, captureStackTrace } from "./traces.js";
import type { RenderStreamContextValue } from "./context.js";
import {
  RenderStreamContextProvider,
  useRenderStreamContext,
} from "./context.js";
import { disableActWarnings } from "./disableActWarnings.js";
import { render as baseRender, RenderOptions } from "@testing-library/react";
import { Assertable, markAssertable } from "../assertable.js";

export type ValidSnapshot =
  | void
  | (object & { /* not a function */ call?: never });

/** only used for passing around data internally */
const _stackTrace = Symbol();

export interface NextRenderOptions {
  timeout?: number;
  [_stackTrace]?: string;
}

interface ReplaceSnapshot<Snapshot> {
  (newSnapshot: Snapshot): void;
  (updateSnapshot: (lastSnapshot: Readonly<Snapshot>) => Snapshot): void;
}

interface MergeSnapshot<Snapshot> {
  (partialSnapshot: Partial<Snapshot>): void;
  (
    updatePartialSnapshot: (
      lastSnapshot: Readonly<Snapshot>
    ) => Partial<Snapshot>
  ): void;
}

export interface ProfiledComponentOnlyFields<Snapshot> {
  // Allows for partial updating of the snapshot by shallow merging the results
  mergeSnapshot: MergeSnapshot<Snapshot>;
  // Performs a full replacement of the snapshot
  replaceSnapshot: ReplaceSnapshot<Snapshot>;
}
export interface ProfiledComponentFields<Snapshot> {
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
  peekRender(options?: NextRenderOptions): Promise<Render<Snapshot>>;
  /**
   * Iterates to the next render and returns it.
   * If no render has happened yet, it will wait for the next render to happen.
   * @throws {WaitForRenderTimeoutError} if no render happens within the timeout
   */
  takeRender: Assertable &
    ((options?: NextRenderOptions) => Promise<Render<Snapshot>>);
  /**
   * Returns the total number of renders.
   */
  totalRenderCount(): number;
  /**
   * Returns the current render.
   * @throws {Error} if no render has happened yet
   */
  getCurrentRender(): Render<Snapshot>;
  /**
   * Waits for the next render to happen.
   * Does not advance the render iterator.
   */
  waitForNextRender(options?: NextRenderOptions): Promise<Render<Snapshot>>;
}

export interface RenderStream<Snapshot extends ValidSnapshot>
  extends ProfiledComponentFields<Snapshot>,
    ProfiledComponentOnlyFields<Snapshot> {}

export interface RenderStreamWithRenderFn<Snapshot extends ValidSnapshot>
  extends RenderStream<Snapshot> {
  render: typeof baseRender;
}

export type RenderStreamOptions<Snapshot extends ValidSnapshot> = {
  onRender?: (
    info: BaseRender & {
      snapshot: Snapshot;
      replaceSnapshot: ReplaceSnapshot<Snapshot>;
      mergeSnapshot: MergeSnapshot<Snapshot>;
    }
  ) => void;
  snapshotDOM?: boolean;
  initialSnapshot?: Snapshot;
  /**
   * This will skip renders during which no renders tracked by
   * `useTrackRenders` occured.
   */
  skipNonTrackingRenders?: boolean;
};

export function createRenderStream<Snapshot extends ValidSnapshot = void>({
  onRender,
  snapshotDOM = false,
  initialSnapshot,
  skipNonTrackingRenders,
}: RenderStreamOptions<Snapshot> = {}): RenderStreamWithRenderFn<Snapshot> {
  let nextRender: Promise<Render<Snapshot>> | undefined;
  let resolveNextRender: ((render: Render<Snapshot>) => void) | undefined;
  let rejectNextRender: ((error: unknown) => void) | undefined;
  function resetNextRender() {
    nextRender = resolveNextRender = rejectNextRender = undefined;
  }
  const snapshotRef = { current: initialSnapshot };
  const replaceSnapshot: ReplaceSnapshot<Snapshot> = (snap) => {
    if (typeof snap === "function") {
      if (!initialSnapshot) {
        throw new Error(
          "Cannot use a function to update the snapshot if no initial snapshot was provided."
        );
      }
      snapshotRef.current = snap(
        typeof snapshotRef.current === "object"
          ? // "cheap best effort" to prevent accidental mutation of the last snapshot
            { ...snapshotRef.current! }
          : snapshotRef.current!
      );
    } else {
      snapshotRef.current = snap;
    }
  };

  const mergeSnapshot: MergeSnapshot<Snapshot> = (partialSnapshot) => {
    replaceSnapshot((snapshot) => ({
      ...snapshot,
      ...(typeof partialSnapshot === "function"
        ? partialSnapshot(snapshot)
        : partialSnapshot),
    }));
  };

  const profilerContext: RenderStreamContextValue = {
    renderedComponents: [],
  };

  const profilerOnRender: React.ProfilerOnRenderCallback = (
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime
  ) => {
    if (
      skipNonTrackingRenders &&
      profilerContext.renderedComponents.length === 0
    ) {
      return;
    }
    const baseRender = {
      id,
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
      count: Profiler.renders.length + 1,
    };
    try {
      /*
       * The `onRender` function could contain `expect` calls that throw
       * `JestAssertionError`s - but we are still inside of React, where errors
       * might be swallowed.
       * So we record them and re-throw them in `takeRender`
       * Additionally, we reject the `waitForNextRender` promise.
       */
      onRender?.({
        ...baseRender,
        replaceSnapshot,
        mergeSnapshot,
        snapshot: snapshotRef.current!,
      });

      const snapshot = snapshotRef.current as Snapshot;
      const domSnapshot = snapshotDOM
        ? window.document.body.innerHTML
        : undefined;
      const render = new RenderInstance(
        baseRender,
        snapshot,
        domSnapshot,
        profilerContext.renderedComponents
      );
      profilerContext.renderedComponents = [];
      Profiler.renders.push(render);
      resolveNextRender?.(render);
    } catch (error) {
      Profiler.renders.push({
        phase: "snapshotError",
        count: Profiler.renders.length,
        error,
      });
      rejectNextRender?.(error);
    } finally {
      resetNextRender();
    }
  };

  let iteratorPosition = 0;
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <RenderStreamContextProvider value={profilerContext}>
        <React.Profiler id="test" onRender={profilerOnRender}>
          {children}
        </React.Profiler>
      </RenderStreamContextProvider>
    );
  }

  const render = ((
    ui: React.ReactNode,
    options?: RenderOptions<any, any, any>
  ) => {
    return baseRender(ui, {
      ...options,
      wrapper: (props) => {
        let elem: React.ReactNode = React.createElement(
          Wrapper,
          undefined,
          props.children
        );
        if (options?.wrapper) {
          elem = React.createElement(options.wrapper, undefined, elem);
        }
        return elem;
      },
    });
  }) as typeof baseRender;

  let Profiler: RenderStreamWithRenderFn<Snapshot> = {} as any;
  Profiler = Object.assign(
    Profiler as {},
    {
      replaceSnapshot,
      mergeSnapshot,
    } satisfies ProfiledComponentOnlyFields<Snapshot>,
    {
      renders: new Array<
        | Render<Snapshot>
        | { phase: "snapshotError"; count: number; error: unknown }
      >(),
      totalRenderCount() {
        return Profiler.renders.length;
      },
      async peekRender(options: NextRenderOptions = {}) {
        if (iteratorPosition < Profiler.renders.length) {
          const render = Profiler.renders[iteratorPosition];

          if (render.phase === "snapshotError") {
            throw render.error;
          }

          return render;
        }
        return Profiler.waitForNextRender({
          [_stackTrace]: captureStackTrace(Profiler.peekRender),
          ...options,
        });
      },
      takeRender: markAssertable(async function takeRender(
        options: NextRenderOptions = {}
      ) {
        // In many cases we do not control the resolution of the suspended
        // promise which results in noisy tests when the profiler due to
        // repeated act warnings.
        using _disabledActWarnings = disableActWarnings();

        let error: unknown = undefined;

        try {
          return await Profiler.peekRender({
            [_stackTrace]: captureStackTrace(Profiler.takeRender),
            ...options,
          });
        } catch (e) {
          error = e;
          throw e;
        } finally {
          if (!(error && error instanceof WaitForRenderTimeoutError)) {
            iteratorPosition++;
          }
        }
      }, Profiler),
      getCurrentRender() {
        // The "current" render should point at the same render that the most
        // recent `takeRender` call returned, so we need to get the "previous"
        // iterator position, otherwise `takeRender` advances the iterator
        // to the next render. This means we need to call `takeRender` at least
        // once before we can get a current render.
        const currentPosition = iteratorPosition - 1;

        if (currentPosition < 0) {
          throw new Error(
            "No current render available. You need to call `takeRender` before you can get the current render."
          );
        }

        const render = Profiler.renders[currentPosition];

        if (render.phase === "snapshotError") {
          throw render.error;
        }
        return render;
      },
      waitForNextRender({
        timeout = 1000,
        // capture the stack trace here so its stack trace is as close to the calling code as possible
        [_stackTrace]: stackTrace = captureStackTrace(
          Profiler.waitForNextRender
        ),
      }: NextRenderOptions = {}) {
        if (!nextRender) {
          nextRender = Promise.race<Render<Snapshot>>([
            new Promise<Render<Snapshot>>((resolve, reject) => {
              resolveNextRender = resolve;
              rejectNextRender = reject;
            }),
            new Promise<Render<Snapshot>>((_, reject) =>
              setTimeout(() => {
                reject(
                  applyStackTrace(new WaitForRenderTimeoutError(), stackTrace)
                );
                resetNextRender();
              }, timeout)
            ),
          ]);
        }
        return nextRender;
      },
    } satisfies ProfiledComponentFields<Snapshot>,
    { render }
  );
  return Profiler;
}

export class WaitForRenderTimeoutError extends Error {
  constructor() {
    super("Exceeded timeout waiting for next render.");
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function resolveR18HookOwner(): React.ComponentType | undefined {
  return (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
    ?.ReactCurrentOwner?.current?.elementType;
}

function resolveR19HookOwner(): React.ComponentType | undefined {
  return (
    React as any
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.A?.getOwner()
    .elementType;
}

export function useTrackRenders({ name }: { name?: string } = {}) {
  const component = name || resolveR18HookOwner() || resolveR19HookOwner();

  if (!component) {
    throw new Error(
      "useTrackRender: Unable to determine component. Please ensure the hook is called inside a rendered component or provide a `name` option."
    );
  }

  const ctx = useRenderStreamContext();

  if (!ctx) {
    throw new Error(
      "useTrackComponentRender: A Profiler must be created and rendered to track component renders"
    );
  }

  React.useLayoutEffect(() => {
    ctx.renderedComponents.unshift(component);
  });
}
