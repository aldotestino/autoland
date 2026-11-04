import { BunHttpClient, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Metric } from "effect";
import { HttpRouter } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { HelloRpcs } from "./api";

const HelloCounter = Metric.counter("HelloCounter", {
  description: "Total numbers of hello",
}).pipe(Metric.withConstantInput(1));

const HelloHandlers = HelloRpcs.toLayer({
  SayHello: ({ name }) =>
    Effect.succeed(`Hello, ${name}`).pipe(
      Effect.withSpan("Hello.SayHello", {
        attributes: { name },
      }),
      Effect.tap(Metric.update(HelloCounter, name)),
    ),
  GetHelloCount: () =>
    Metric.value(HelloCounter).pipe(
      Effect.map((res) => res.count),
      Effect.withSpan("Hello.HelloCounter"),
    ),
});

const RpcLayer = RpcServer.layerHttp({
  group: HelloRpcs,
  path: "/rpc",
  protocol: "http",
  disableFatalDefects: true,
}).pipe(Layer.provide(HelloHandlers), Layer.provide(RpcSerialization.layerJson));

const Observability = Otlp.layerFromConfig({
  resource: {
    serviceName: "scratchpad-server",
  },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(BunHttpClient.layer));

const Main = HttpRouter.serve(RpcLayer).pipe(
  Layer.provide(BunHttpServer.layerConfig({})),
  Layer.provide(Observability),
);

BunRuntime.runMain(Layer.launch(Main));
