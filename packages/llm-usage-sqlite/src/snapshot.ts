import { type FileHandle, open, rm } from 'node:fs/promises';

/** Owns the temporary directory until completion, cancellation, or failure. */
export async function snapshotStream(
  path: string,
  directory: string,
  source?: FileHandle,
): Promise<ReadableStream<Uint8Array>> {
  let file = source;
  const cleanup = async (): Promise<void> => {
    await file?.close().catch((): void => {});
    await rm(directory, { recursive: true, force: true }).catch((): void => {});
  };
  try {
    const handle = file ?? (await open(path, 'r'));
    file = handle;
    return new ReadableStream<Uint8Array>({
      async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
        try {
          const buffer = new Uint8Array(64 * 1024);
          const { bytesRead } = await handle.read(buffer);
          if (bytesRead === 0) {
            await cleanup();
            controller.close();
          } else controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          await cleanup();
          controller.error(failure);
        }
      },
      async cancel() {
        await cleanup();
      },
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await cleanup();
    throw failure;
  }
}
