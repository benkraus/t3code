import { tmpdir } from "node:os";
import { Effect, type FileSystem, type Path } from "effect";

import { runProcess } from "../../processRunner";

export async function ensureSwiftHelperBinary(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly directory: string;
  readonly basename: string;
  readonly source: string;
  readonly compilerArgs?: ReadonlyArray<string>;
}): Promise<string> {
  const { basename, compilerArgs, directory, fileSystem, path, source } = input;
  const helperDirectory = path.join(tmpdir(), directory);
  const sourcePath = path.join(helperDirectory, `${basename}.swift`);
  const binaryPath = path.join(helperDirectory, basename);

  await Effect.runPromise(fileSystem.makeDirectory(helperDirectory, { recursive: true }));

  const existingSource = await Effect.runPromise(
    fileSystem.readFileString(sourcePath).pipe(Effect.catch(() => Effect.succeed(null))),
  );
  if (existingSource !== source) {
    await Effect.runPromise(fileSystem.writeFileString(sourcePath, source));
  }

  const binaryExists = await Effect.runPromise(fileSystem.exists(binaryPath));
  if (binaryExists && existingSource === source) {
    return binaryPath;
  }

  await runProcess(
    "xcrun",
    ["swiftc", "-O", ...(compilerArgs ?? []), sourcePath, "-o", binaryPath],
    {
      timeoutMs: 30_000,
    },
  );

  return binaryPath;
}
