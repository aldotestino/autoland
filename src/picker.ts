import { Effect, Option, Terminal } from "effect";
import { Prompt } from "effect/cli";
import { type OpenPull } from "./github";
import { sanitize } from "./domain";

/** Title, help, and a blank line above the list, and the footer below it. */
const CHROME_ROWS = 4;

export interface PickerEntry {
  readonly number: number;
  readonly label: string;
}

export interface PickerState {
  readonly cursor: number;
  readonly top: number;
  readonly checked: ReadonlyArray<boolean>;
  readonly message: string;
}

export type PickerKey = "up" | "down" | "toggle" | "all" | "confirm" | "cancel" | "ignored";

export type PickerStep =
  | { readonly _tag: "Next"; readonly state: PickerState }
  | { readonly _tag: "Confirmed"; readonly numbers: ReadonlyArray<number> }
  | { readonly _tag: "Cancelled" };

/** Sorted by number, with untrusted PR text made safe to print. */
export const toEntries = (pulls: ReadonlyArray<OpenPull>): ReadonlyArray<PickerEntry> =>
  [...pulls]
    .sort((a, b) => a.number - b.number)
    .map(({ author, number, title }) => ({
      number,
      label: `#${number} ${sanitize(title)} (@${sanitize(author ?? "ghost")})`,
    }));

export const initialState = (size: number): PickerState => ({
  cursor: 0,
  top: 0,
  checked: Array.from({ length: size }, () => false),
  message: "",
});

export const visibleRows = (rows: number): number =>
  Math.max((rows > 0 ? rows : 24) - CHROME_ROWS, 1);

/** Scrolls just enough to keep the cursor visible. */
export const withViewport = (state: PickerState, rows: number): PickerState => {
  const visible = visibleRows(rows);
  const top =
    state.cursor < state.top
      ? state.cursor
      : state.cursor >= state.top + visible
        ? state.cursor - visible + 1
        : state.top;
  return top === state.top ? state : { ...state, top };
};

export const step = (
  entries: ReadonlyArray<PickerEntry>,
  previous: PickerState,
  key: PickerKey,
): PickerStep => {
  const state = { ...previous, message: "" };
  switch (key) {
    case "up":
      return { _tag: "Next", state: { ...state, cursor: Math.max(state.cursor - 1, 0) } };
    case "down":
      return {
        _tag: "Next",
        state: { ...state, cursor: Math.min(state.cursor + 1, entries.length - 1) },
      };
    case "toggle":
      return {
        _tag: "Next",
        state: {
          ...state,
          checked: state.checked.map((value, index) => (index === state.cursor ? !value : value)),
        },
      };
    case "all": {
      // Select all, unless everything is already selected.
      const target = state.checked.includes(false);
      return { _tag: "Next", state: { ...state, checked: state.checked.map(() => target) } };
    }
    case "confirm": {
      const numbers = entries
        .filter((_, index) => state.checked[index])
        .map((entry) => entry.number);
      return numbers.length > 0
        ? { _tag: "Confirmed", numbers }
        : {
            _tag: "Next",
            state: { ...state, message: "Select at least one PR, or press q to cancel." },
          };
    }
    case "cancel":
      return { _tag: "Cancelled" };
    case "ignored":
      return { _tag: "Next", state };
  }
};

export const parseKey = ({ key }: Terminal.UserInput): PickerKey => {
  // A bare Esc is reported with `meta` set, like the start of any other sequence.
  if (key.name === "escape") return "cancel";
  if (key.ctrl || key.meta) return "ignored";
  switch (key.name) {
    case "up":
    case "k":
      return "up";
    case "down":
    case "j":
      return "down";
    case "space":
      return "toggle";
    case "a":
      return "all";
    case "return":
    case "enter":
      return "confirm";
    case "q":
      return "cancel";
    default:
      return "ignored";
  }
};

export const renderFrame = (input: {
  readonly repo: string;
  readonly entries: ReadonlyArray<PickerEntry>;
  readonly state: PickerState;
  readonly rows: number;
  readonly colors: boolean;
}): string => {
  const { colors, entries, repo, rows, state } = input;
  const end = Math.min(state.top + visibleRows(rows), entries.length);
  const picked = state.checked.filter(Boolean).length;
  // Autowrap is off while the picker is open: long titles clip, and each PR uses one row.
  const lines = [
    `\u001b[HSelect PRs to merge in ${repo} (${picked} of ${entries.length} selected)`,
    "↑/↓ move · space toggle · a all · enter confirm · q cancel",
    "",
    ...entries.slice(state.top, end).map((entry, offset) => {
      const index = state.top + offset;
      const isCursor = index === state.cursor;
      const label = isCursor && colors ? `\u001b[36m${entry.label}\u001b[0m` : entry.label;
      return `${isCursor ? ">" : " "} [${state.checked[index] ? "x" : " "}] ${label}`;
    }),
  ];
  const showing =
    end - state.top < entries.length
      ? `Showing ${state.top + 1}-${end} of ${entries.length}. `
      : "";
  return `${lines.join("\u001b[K\n")}\u001b[K\n${showing}${state.message}\u001b[K\u001b[J`;
};

/** A full-screen checkbox list. Resolves to the chosen numbers, or none when cancelled. */
export const picker = (
  repo: string,
  entries: ReadonlyArray<PickerEntry>,
): Prompt.Prompt<Option.Option<ReadonlyArray<number>>> =>
  Prompt.Custom(initialState(entries.length), {
    render: (state, action) =>
      Effect.gen(function* () {
        if (action._tag === "Submit") return "";
        const terminal = yield* Terminal.Terminal;
        const { colors } = yield* Prompt.Theme;
        return renderFrame({ repo, entries, state, rows: yield* terminal.rows, colors });
      }),
    process: (input, state) =>
      Effect.gen(function* () {
        const terminal = yield* Terminal.Terminal;
        const next = step(entries, state, parseKey(input));
        switch (next._tag) {
          case "Next":
            return {
              _tag: "NextFrame" as const,
              state: withViewport(next.state, yield* terminal.rows),
            };
          case "Confirmed":
            return { _tag: "Submit" as const, value: Option.some(next.numbers) };
          case "Cancelled":
            return { _tag: "Submit" as const, value: Option.none() };
        }
      }),
    // Each frame repaints the screen from the top.
    clear: () => Effect.succeed(""),
  });
