import type { IosSimulatorInteractionInput, IosSimulatorStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { Stream } from "effect";

export interface IosSimulatorFrame {
  readonly contentType: "image/png";
  readonly data: Uint8Array;
}

export interface IosSimulatorMultipartStream {
  readonly contentType: string;
  readonly stream: Stream.Stream<Uint8Array, Error>;
}

export interface IosSimulatorShape {
  readonly getStatus: Effect.Effect<IosSimulatorStatus>;
  readonly captureFrame: Effect.Effect<IosSimulatorFrame, Error>;
  readonly openMjpegStream: Effect.Effect<IosSimulatorMultipartStream, Error>;
  readonly sendInput: (input: IosSimulatorInteractionInput) => Effect.Effect<void, Error>;
}

export class IosSimulator extends ServiceMap.Service<IosSimulator, IosSimulatorShape>()(
  "t3/iosSimulator/Services/IosSimulator",
) {}
