import type { AIProvider, ProviderName, RunJsonInThreadResult, RunJsonResult, RunOptions } from "../provider-types";
import { runJsonPi, runJsonInThreadPi } from "../pi-coder";

export class PiProvider implements AIProvider {
  readonly name: ProviderName = "pi";

  async runJson<T>(
    prompt: string,
    outputSchema: object,
    opts?: RunOptions,
  ): Promise<RunJsonResult<T>> {
    return runJsonPi<T>(prompt, outputSchema, opts);
  }

  async runJsonInThread<T>(args: {
    outputSchema: object;
    opts?: RunOptions;
    resume?: { threadId: string; input: string };
    start?: { input: string };
  }): Promise<RunJsonInThreadResult<T>> {
    return runJsonInThreadPi<T>(args);
  }
}
