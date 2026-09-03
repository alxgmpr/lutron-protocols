import type { JsonObject, JsonValue } from "../../lib/data-values";

/** Duck-typed stand-in for LeapConnection in tests — returns canned readBody() responses. */
export class MockLeap {
  private responses: JsonObject;
  readonly readCalls: string[] = [];

  constructor(responses: JsonObject) {
    this.responses = responses;
  }

  async readBody(url: string): Promise<JsonValue> {
    this.readCalls.push(url);
    return url in this.responses ? this.responses[url] : null;
  }
}
