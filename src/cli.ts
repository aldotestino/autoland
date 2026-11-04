import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Context, Effect, Layer, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { Otlp, OtlpSerialization } from "effect/observability";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { HelloRpcs } from "./api";

class HelloClient extends Context.Service<HelloClient>()("effect-scratchpad/cli/HelloClient", {
  make: RpcClient.make(HelloRpcs),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url: "http://localhost:3000/rpc",
      }),
    ),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(BunHttpClient.layer),
  );
}

const sayHello = Command.make(
  "say-hello",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("Who to say hello to"),
      Argument.withSchema(Schema.NonEmptyString),
    ),
  },
  Effect.fn("Hello.SayHello")(function* ({ name }) {
    const helloClient = yield* HelloClient;

    const helloResult = yield* helloClient.SayHello({ name });

    yield* Console.log(helloResult);
  }),
).pipe(Command.withDescription("Say Hello"));

const helloCounter = Command.make(
  "get-hello-count",
  {},
  Effect.fn("Hello.GetHelloCount")(function* () {
    const helloClient = yield* HelloClient;

    const helloCountResult = yield* helloClient.GetHelloCount();

    yield* Console.log(helloCountResult);
  }),
);

const Observability = Otlp.layerFromConfig({
  resource: {
    serviceName: "scratchpad-cli",
  },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(BunHttpClient.layer));

const hello = Command.make("hello");

const CliLayer = Layer.mergeAll(HelloClient.layer, BunServices.layer, Observability);

hello.pipe(
  Command.withSubcommands([sayHello, helloCounter]),
  Command.run({
    version: "0.0.1",
  }),
  Effect.provide(CliLayer),
  BunRuntime.runMain,
);
