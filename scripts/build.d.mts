export function validateBuildOutput(options: {
  outputRoot: string;
  safeRoot: string;
}): { outputRoot: string; safeRoot: string };

export function prepareBuildOutput(options: {
  outputRoot: string;
  safeRoot: string;
}): Promise<{ outputRoot: string; safeRoot: string }>;

export function preflightBuildInputs(sourceRoot?: string): Promise<void>;

export function buildExtension(options: {
  outputRoot: string;
  safeRoot: string;
}): Promise<{ outputRoot: string; safeRoot: string }>;

export function buildDefaultExtension(options?: {
  sourceRoot?: string;
  outputRoot?: string;
  safeRoot?: string;
}): Promise<{ outputRoot: string; safeRoot: string }>;

export function buildDefaultProject(): Promise<{ outputRoot: string; safeRoot: string }>;
