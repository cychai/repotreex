export function buildPackage(options?: {
  outputRoot?: string;
}): Promise<{
  archivePath: string;
  extensionRoot: string;
  files: string[];
}>;
