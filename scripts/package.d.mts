export function buildPackage(options?: {
  outputRoot?: string;
  callerTimeZone?: string;
}): Promise<{
  archivePath: string;
  extensionRoot: string;
  files: string[];
}>;
