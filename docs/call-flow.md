# CLI to Server Call Flow

Both CLI commands use the same RPC path. The shared contract is defined in
`src/api.ts` and is used to build the client and server handlers.

```mermaid
sequenceDiagram
    actor User
    participant CLI as Bun CLI (`src/cli.ts`)
    participant Client as RpcClient
    participant HTTP as HTTP (`localhost:3000/rpc`)
    participant Server as RpcServer (`src/server.ts`)
    participant Handler as HelloRpcs handlers
    participant Metrics as HelloCounter

    User->>CLI: `bun run cli -- hello say-hello Alice`
    CLI->>CLI: Parse command and validate `name`
    CLI->>Client: `SayHello({ name: "Alice" })`
    Client->>Client: Encode RPC as JSON
    Client->>HTTP: HTTP request to `/rpc`
    HTTP->>Server: Route request to `RpcServer`
    Server->>Server: Decode and validate RPC payload
    Server->>Handler: `SayHello({ name })`
    Handler->>Metrics: Increment `HelloCounter`
    Handler-->>Server: `Hello, Alice`
    Server->>Server: Encode response as JSON
    Server-->>HTTP: HTTP response
    HTTP-->>Client: JSON RPC response
    Client->>Client: Decode and validate result
    Client-->>CLI: `Hello, Alice`
    CLI-->>User: Print result

    User->>CLI: `bun run cli -- hello get-hello-count`
    CLI->>Client: `GetHelloCount()`
    Client->>HTTP: HTTP request to `/rpc`
    HTTP->>Server: Route request to `RpcServer`
    Server->>Handler: `GetHelloCount()`
    Handler->>Metrics: Read `HelloCounter`
    Metrics-->>Handler: Current count
    Handler-->>Server: Count
    Server-->>HTTP: HTTP response
    HTTP-->>Client: JSON RPC response
    Client-->>CLI: Count
    CLI-->>User: Print count
```

## Runtime Setup

- The server starts with `bun run server` and listens through `BunHttpServer`.
- The CLI creates an `RpcClient` pointed at `http://localhost:3000/rpc`.
- `RpcSerialization.layerJson` handles JSON encoding and decoding on both sides.
- OpenTelemetry layers create spans for CLI commands and server handlers and
  export them through OTLP when configured.
