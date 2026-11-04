import { AbsolutePath, Location, OpenCode, type OpenCodeClient } from "@opencode/client/effect";
import { Service } from "@opencode/client/effect/service";
import { Context, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { Prompt } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import { sanitizeText } from "./domain";
import { Tty } from "./tty";
import { Ui } from "./ui";

export class OpenCodeError extends Schema.TaggedError<
  OpenCodeError,
  { readonly brand: unique symbol }
>()("OpenCodeError", {
  message: Schema.String,
}) {}

/** How long to wait before checking on a session whose event stream ended. */
const RECONNECT_DELAY = "1 second";

const WATCHED_EVENTS = [
  "permission.asked",
  "form.created",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

type SessionID = Parameters<OpenCodeClient["permission"]["reply"]>[0]["sessionID"];
type RequestID = Parameters<OpenCodeClient["permission"]["reply"]>[0]["requestID"];

export interface PermissionDetails {
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly save?: ReadonlyArray<string> | undefined;
  readonly message?: string | undefined;
}

interface PermissionAsk extends PermissionDetails {
  readonly id: RequestID;
}

export type PermissionDecision = "once" | "always" | "reject";

/** PR text reaches the agent, so what it asks for is untrusted too. */
export const permissionQuestion = (ask: PermissionDetails): string => {
  const resources = ask.resources.map(sanitizeText).join(", ");
  const detail = ask.message ? `\n${sanitizeText(ask.message)}` : "";
  return `OpenCode asks to ${sanitizeText(ask.action)}: ${resources}${detail}`;
};

export const permissionChoices = (ask: PermissionDetails) => [
  { title: "Allow once", value: "once" as PermissionDecision },
  // Saving needs patterns from the server; without them, "always" means nothing.
  ...(ask.save && ask.save.length > 0
    ? [{ title: "Always allow", value: "always" as PermissionDecision }]
    : []),
  { title: "Reject", value: "reject" as PermissionDecision },
];

const describe = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : String(cause);

const failWith = (context: string) =>
  Effect.mapError(
    (cause: unknown) => new OpenCodeError({ message: `${context}: ${describe(cause)}` }),
  );

/** The last thing the agent said, or an empty string when it said nothing. */
const lastReport = (client: OpenCodeClient, sessionID: SessionID) =>
  client.message.list({ sessionID, type: "assistant", order: "desc", limit: 1 }).pipe(
    Effect.map((page) =>
      page.data
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n"),
    ),
    Effect.orElseSucceed(() => ""),
  );

/** Runs agent sessions on the local OpenCode background service. */
export class Agent extends Context.Service<
  Agent,
  {
    /** Starts the service if needed. Run this first, so failures cost nothing. */
    readonly connect: Effect.Effect<void, OpenCodeError>;
    /** Resolves once the session stops working, with its final report. */
    readonly runSession: (input: {
      readonly directory: string;
      readonly title: string;
      readonly prompt: string;
    }) => Effect.Effect<string, OpenCodeError>;
  }
>()("autoland/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const ui = yield* Ui;
      const tty = yield* Tty;
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;

      const client = Effect.gen(function* () {
        const endpoint = yield* Service.ensure().pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        return yield* OpenCode.make({ baseUrl: endpoint.url }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.mapRequest(http, (request) =>
              HttpClientRequest.setHeaders(request, Service.headers(endpoint) ?? {}),
            ),
          ),
        );
      }).pipe(failWith("Cannot reach OpenCode"));

      return Agent.of({
        connect: Effect.asVoid(client),

        runSession: Effect.fn("Agent.runSession")(function* ({ directory, prompt, title }) {
          const opencode = yield* client;
          const session = yield* opencode.session
            .create({
              title,
              location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
            })
            .pipe(failWith("Cannot create an OpenCode session"));
          const sessionID = session.id;
          const attach = `opencode ${directory} --session ${sessionID}`;
          yield* ui.log(`Follow along or take over from another terminal:\n  ${attach}\n`);

          const seen = new Set<string>();
          let promptSent = false;

          const askUser = (ask: PermissionAsk) =>
            ui.pausing(
              tty.prompt(
                Prompt.Select({
                  message: permissionQuestion(ask),
                  choices: permissionChoices(ask),
                }),
              ),
            );

          /** It may also be answered in an attached OpenCode UI, which settles the prompt. */
          const answeredElsewhere = (requestID: RequestID) =>
            opencode.event.subscribe({ types: ["permission.replied"] }).pipe(
              Stream.filter(
                (event) =>
                  event.type === "permission.replied" && event.data.requestID === requestID,
              ),
              Stream.runHead,
              Effect.ignore,
              Effect.andThen(Effect.never),
            );

          const handlePermission = (ask: PermissionAsk) =>
            Effect.gen(function* () {
              if (seen.has(ask.id)) return;
              seen.add(ask.id);
              const answer = yield* Effect.raceFirst(
                askUser(ask),
                answeredElsewhere(ask.id).pipe(Effect.as(undefined)),
              );
              if (answer === undefined) return;
              yield* opencode.permission
                .reply({
                  sessionID,
                  requestID: ask.id,
                  decision: Option.getOrElse(answer, () => "reject" as const),
                })
                .pipe(
                  Effect.catch((cause) =>
                    ui.error(`Cannot answer OpenCode's request: ${describe(cause)}`),
                  ),
                );
            });

          const handleForm = (form: { readonly id: string; readonly title: string }) =>
            Effect.gen(function* () {
              if (seen.has(form.id)) return;
              seen.add(form.id);
              yield* tty.notify("OpenCode needs an answer", "A repair session is waiting");
              yield* ui.pausing(
                ui.log(
                  `OpenCode has a question only its UI can show: ${sanitizeText(form.title)}\nAnswer it with:\n  ${attach}`,
                ),
              );
            });

          /** Anything asked while no stream was connected would otherwise be missed. */
          const catchUp = Effect.gen(function* () {
            const permissions = yield* opencode.permission.list({ sessionID });
            yield* Effect.forEach(permissions, handlePermission, { discard: true });
            const forms = yield* opencode.session.form.list({ sessionID });
            yield* Effect.forEach(forms, handleForm, { discard: true });
          }).pipe(failWith("Cannot read OpenCode's pending requests"));

          type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

          // `server.connected` means no event can be missed from here on, so the
          // prompt is only sent once the first connection is up.
          const watch = opencode.event.subscribe({ types: [...WATCHED_EVENTS] }).pipe(
            // A dropped stream is not a failed session: the caller checks and reconnects.
            Stream.catch(() => Stream.empty),
            Stream.mapEffect((event): Effect.Effect<Option.Option<Outcome>, OpenCodeError> =>
              Effect.gen(function* () {
                switch (event.type) {
                  case "server.connected":
                    if (!promptSent) {
                      promptSent = true;
                      yield* opencode.session
                        .prompt({ sessionID, text: prompt })
                        .pipe(failWith("Cannot send the prompt to OpenCode"));
                    }
                    yield* catchUp;
                    return Option.none();
                  case "permission.asked":
                    if (event.data.sessionID === sessionID) yield* handlePermission(event.data);
                    return Option.none();
                  case "form.created":
                    if (event.data.form.sessionID === sessionID) {
                      yield* handleForm(event.data.form);
                    }
                    return Option.none();
                  case "session.execution.succeeded":
                    return event.data.sessionID === sessionID
                      ? Option.some<Outcome>({ ok: true })
                      : Option.none();
                  case "session.execution.failed":
                    return event.data.sessionID === sessionID
                      ? Option.some<Outcome>({
                          ok: false,
                          reason: describe(event.data.error),
                        })
                      : Option.none();
                  case "session.execution.interrupted":
                    return event.data.sessionID === sessionID
                      ? Option.some<Outcome>({
                          ok: false,
                          reason: `interrupted (${event.data.reason})`,
                        })
                      : Option.none();
                  default:
                    return Option.none();
                }
              }),
            ),
            Stream.filter(Option.isSome),
            Stream.runHead,
            Effect.map(Option.flatten),
          );

          const untilFinished = Effect.gen(function* () {
            while (true) {
              const outcome = yield* watch;
              if (Option.isSome(outcome)) return outcome.value;
              yield* Effect.sleep(RECONNECT_DELAY);
              const active = yield* opencode.session
                .active()
                .pipe(failWith("Lost contact with OpenCode"));
              // Finished while disconnected: the event is gone, so the report has to do.
              if (promptSent && active[sessionID] === undefined) return { ok: true } as Outcome;
            }
          });

          const outcome = yield* untilFinished.pipe(
            // The agent must not keep pushing to the PR after the batch has gone away.
            Effect.onInterrupt(() =>
              opencode.session
                .interrupt({ sessionID })
                .pipe(Effect.timeout("5 seconds"), Effect.ignore),
            ),
          );
          if (!outcome.ok) {
            return yield* new OpenCodeError({
              message: `OpenCode session ended without finishing: ${outcome.reason}`,
            });
          }
          return sanitizeText(yield* lastReport(opencode, sessionID));
        }),
      });
    }),
  );
}
