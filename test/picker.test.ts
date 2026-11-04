import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  initialState,
  parseKey,
  type PickerEntry,
  type PickerKey,
  type PickerState,
  renderFrame,
  step,
  toEntries,
  withViewport,
} from "../src/picker";

const entries: ReadonlyArray<PickerEntry> = [1, 2, 3].map((number) => ({
  number,
  label: `#${number}`,
}));

const press = (state: PickerState, ...keys: ReadonlyArray<PickerKey>) => {
  let current = state;
  for (const key of keys) {
    const next = step(entries, current, key);
    assert.strictEqual(next._tag, "Next");
    if (next._tag === "Next") current = next.state;
  }
  return current;
};

describe("picker", () => {
  it.effect("sorts entries and sanitizes untrusted titles and authors", () =>
    Effect.sync(() => {
      const [first, second] = toEntries([
        { number: 2, title: "b", author: null },
        { number: 1, title: "evil\u001b[2Jtitle", author: "m\u0007e" },
      ]);
      assert.strictEqual(first?.label, "#1 evil [2Jtitle (@m e)");
      assert.strictEqual(second?.label, "#2 b (@ghost)");
    }),
  );

  it.effect("keeps the cursor inside the list", () =>
    Effect.sync(() => {
      assert.strictEqual(press(initialState(3), "up").cursor, 0);
      assert.strictEqual(press(initialState(3), "down", "down", "down", "down").cursor, 2);
    }),
  );

  it.effect("confirms only checked PRs", () =>
    Effect.sync(() => {
      const state = press(initialState(3), "toggle", "down", "down", "toggle");
      assert.deepStrictEqual(step(entries, state, "confirm"), {
        _tag: "Confirmed",
        numbers: [1, 3],
      });
    }),
  );

  it.effect("refuses to confirm an empty selection, and clears the message on the next key", () =>
    Effect.sync(() => {
      const refused = step(entries, initialState(3), "confirm");
      assert.strictEqual(refused._tag, "Next");
      if (refused._tag !== "Next") return;
      assert.include(refused.state.message, "Select at least one");
      assert.strictEqual(press(refused.state, "down").message, "");
    }),
  );

  it.effect("'all' selects everything, then clears when everything is selected", () =>
    Effect.sync(() => {
      const all = press(initialState(3), "toggle", "all");
      assert.deepStrictEqual([...all.checked], [true, true, true]);
      assert.deepStrictEqual([...press(all, "all").checked], [false, false, false]);
    }),
  );

  it.effect("reads keys, treating a bare Esc as cancel despite its meta flag", () =>
    Effect.sync(() => {
      const key = (name: string, flags: { ctrl?: boolean; meta?: boolean } = {}) =>
        parseKey({
          input: Option.none(),
          key: { name, ctrl: false, meta: false, shift: false, ...flags },
        });
      assert.strictEqual(key("escape", { meta: true }), "cancel");
      assert.strictEqual(key("q"), "cancel");
      assert.strictEqual(key("return"), "confirm");
      assert.strictEqual(key("space"), "toggle");
      assert.strictEqual(key("j"), "down");
      assert.strictEqual(key("a", { ctrl: true }), "ignored");
      assert.strictEqual(key("x"), "ignored");
    }),
  );

  it.effect("cancels", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(step(entries, initialState(3), "cancel"), { _tag: "Cancelled" });
    }),
  );

  it.effect("scrolls to keep the cursor visible", () =>
    Effect.sync(() => {
      // 6 rows leave 2 for the list.
      const down = withViewport({ ...initialState(5), cursor: 3 }, 6);
      assert.strictEqual(down.top, 2);
      const up = withViewport({ ...down, cursor: 1 }, 6);
      assert.strictEqual(up.top, 1);
    }),
  );

  it.effect("renders the visible window, its position, and the selection count", () =>
    Effect.sync(() => {
      const frame = renderFrame({
        repo: "acme/widgets",
        entries,
        state: { ...initialState(3), checked: [true, false, false] },
        rows: 6,
        colors: false,
      });
      assert.include(frame, "(1 of 3 selected)");
      assert.include(frame, "> [x] #1");
      assert.include(frame, "  [ ] #2");
      assert.notInclude(frame, "#3");
      assert.include(frame, "Showing 1-2 of 3.");
    }),
  );
});
