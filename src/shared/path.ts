export type SegmentValidationOptions = Readonly<{
  label: string;
  minimum: number;
  allowEmpty?: boolean;
  markers?: readonly string[];
}>;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isSafeSegment(segment: string, markers: readonly string[] = []): boolean {
  return segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !hasControlCharacter(segment) &&
    !markers.includes(segment);
}

export function decodePathSegments(encoded: readonly string[]): string[] | null {
  const decoded: string[] = [];
  for (const segment of encoded) {
    try {
      const value = decodeURIComponent(segment);
      if (!isSafeSegment(value)) return null;
      decoded.push(value);
    } catch {
      return null;
    }
  }
  return decoded;
}

export function validatePathSegments(
  value: string,
  options: SegmentValidationOptions,
): string[] {
  if (options.allowEmpty && value === "") return [];
  const segments = value.split("/");
  const decoded = decodePathSegments(segments);
  if (
    segments.length < options.minimum ||
    decoded === null ||
    decoded.some((segment) => options.markers?.includes(segment))
  ) {
    throw new TypeError(`Invalid ${options.label}`);
  }
  return segments;
}

export function encodePathSegments(segments: readonly string[]): string {
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new TypeError("Invalid path segment");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}
