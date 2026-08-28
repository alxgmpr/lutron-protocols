/** Duck-typed stand-in for LeapConnection in tests — returns canned readBody() responses. */
export class MockLeap {
  private responses: Record<string, unknown>;
  readonly readCalls: string[] = [];

  constructor(responses: Record<string, unknown>) {
    this.responses = responses;
  }

  async readBody(url: string): Promise<unknown> {
    this.readCalls.push(url);
    return url in this.responses ? this.responses[url] : null;
  }
}
