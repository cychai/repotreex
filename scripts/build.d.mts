export function validateBuildOutput(options: {
  outputRoot: string;
  safeRoot: string;
}): { outputRoot: string; safeRoot: string };

export function prepareBuildOutput(options: {
  outputRoot: string;
  safeRoot: string;
}): Promise<{ outputRoot: string; safeRoot: string }>;

export function buildExtension(options?: {
  outputRoot?: string;
  safeRoot?: string;
}): Promise<{ outputRoot: string; safeRoot: string }>;
