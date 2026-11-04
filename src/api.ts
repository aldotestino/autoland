import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export class SayHelloPayload extends Schema.Class<
  SayHelloPayload,
  { readonly brand: unique symbol }
>("HelloPayaload")({
  name: Schema.NonEmptyString,
}) {}

const SayHello = Rpc.make("SayHello", {
  payload: SayHelloPayload,
  success: Schema.NonEmptyString,
});

const GetHelloCount = Rpc.make("GetHelloCount", {
  success: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const HelloRpcs = RpcGroup.make(SayHello, GetHelloCount);
