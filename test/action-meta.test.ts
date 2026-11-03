import {
  data,
  redirect,
  type UNSAFE_DataWithResponseInit as DataWithResponseInit,
} from "react-router";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { attachActionMeta, type WithActionMeta } from "../src/action-meta.ts";

/** A non-record object whose prototype must survive action completion. */
class Receipt {
  readonly id = "receipt";

  /** Expose behavior that spreading the instance would lose. */
  label() {
    return this.id;
  }
}

type Meta = { readonly realtimeEventIds: ReadonlyArray<string> };
const meta: Meta = { realtimeEventIds: ["attempt-one", "attempt-two"] };

it("copies ordinary business fields and replaces only the reserved metadata field", () => {
  const nested = { untouched: true };
  const body = { approvedIds: ["record-one"], nested, __meta: "reserved" };
  const result = attachActionMeta(body, meta);

  expect(result).toEqual({ approvedIds: ["record-one"], nested, __meta: meta });
  expect(result).not.toBe(body);
  expect(result.nested).toBe(nested);
  expect(body.__meta).toBe("reserved");
});

it("supports records with a null prototype and empty records", () => {
  const body = { approved: true };
  Object.setPrototypeOf(body, null);
  expect(attachActionMeta(body, meta)).toEqual({ approved: true, __meta: meta });
  expect(attachActionMeta({}, meta)).toEqual({ __meta: meta });
});

it.each([undefined, 201, { status: 202, statusText: "Queued" }])(
  "preserves the response init of a data wrapper: %j",
  (init) => {
    const wrapped = data({ approved: true }, init);
    const result = attachActionMeta(wrapped, meta);
    expect(result.data).toEqual({ approved: true, __meta: meta });
    expect(result.init).toBe(wrapped.init);
    expect(wrapped.data).toEqual({ approved: true });
  },
);

const excluded = [
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "string", value: "body" },
  { name: "number", value: 42 },
  { name: "boolean", value: false },
  { name: "bigint", value: 42n },
  { name: "symbol", value: Symbol("body") },
  { name: "array", value: ["one"] },
  { name: "empty array", value: [] },
  { name: "date", value: new Date("2026-10-18T00:00:00Z") },
  { name: "map", value: new Map([["one", 1]]) },
  { name: "set", value: new Set(["one"]) },
  { name: "class instance", value: new Receipt() },
  { name: "stream", value: new ReadableStream<string>() },
  { name: "raw JSON response", value: Response.json({ approved: true }) },
  { name: "redirect response", value: redirect("/destination", 303) },
  { name: "typed array", value: new Uint8Array([1, 2]) },
  { name: "regexp", value: /body/ },
  { name: "function", value: () => "body" },
];

describe.each(excluded)("$name", ({ value }) => {
  it("passes through the original value", () => {
    expect(attachActionMeta(value, meta)).toBe(value);
  });

  it("passes through the original data wrapper and its init", () => {
    const wrapper = data(value, {
      status: 202,
      statusText: "Unchanged",
      headers: { "Set-Cookie": "untouched=yes" },
    });
    expect(attachActionMeta(wrapper, meta)).toBe(wrapper);
  });
});

it("does not consume raw Response bodies, directly or inside data", async () => {
  const response = Response.json({ untouched: true });
  attachActionMeta(response, meta);
  attachActionMeta(data(response), meta);
  expect(response.bodyUsed).toBe(false);
  expect(await response.text()).toBe('{"untouched":true}');
});

it("does not mistake a business record with data and init fields for a data wrapper", () => {
  const body = {
    type: "DataWithResponseInit",
    data: { value: 1 },
    init: null,
    approvedIds: ["record-one"],
  };
  expect(attachActionMeta(body, meta)).toEqual({ ...body, __meta: meta });
});

it("types metadata as optional on records and data bodies only", () => {
  type Body = { kind: "approved"; ids: string[] } | { kind: "rejected"; reply: string };
  type Result = WithActionMeta<Body, Meta>;
  expectTypeOf<Extract<Result, { kind: "approved" }>["ids"]>().toEqualTypeOf<string[]>();
  expectTypeOf<Extract<Result, { kind: "rejected" }>["reply"]>().toEqualTypeOf<string>();
  expectTypeOf<Result["__meta"]>().toEqualTypeOf<Meta | undefined>();
  expectTypeOf<WithActionMeta<DataWithResponseInit<Body>, Meta>["data"]>().toEqualTypeOf<Result>();

  type Excluded =
    | null
    | undefined
    | void
    | string
    | number
    | boolean
    | bigint
    | symbol
    | ReadonlyArray<string>
    | Date
    | Map<string, number>
    | Set<string>
    | Receipt
    | ReadableStream<string>
    | Response
    | Uint8Array
    | RegExp
    | (() => string);
  expectTypeOf<WithActionMeta<Excluded, Meta>>().toEqualTypeOf<Excluded>();
  expectTypeOf<WithActionMeta<DataWithResponseInit<Excluded>, Meta>>().toEqualTypeOf<
    DataWithResponseInit<Excluded>
  >();
});

it("leaves data unchanged when no metadata is configured", () => {
  expectTypeOf<WithActionMeta<{ a: 1 }, never>>().toEqualTypeOf<{ a: 1 }>();
});
