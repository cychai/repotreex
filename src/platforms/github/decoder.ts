import type { DirectoryListing } from "../../content/provider";
import { RepositoryError } from "../../shared/errors";

const GITHUB_MAX_HTML_UNITS = 2_000_000;
const GITHUB_MAX_ENTRIES = 10_000;
const GITHUB_MAX_REFS = 100;
const embeddedDataSelector = 'script[type="application/json"][data-target="react-app.embeddedData"]';
const isArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

export type GitHubExpectedPage = Readonly<{
  repository: string;
  ref: string | null;
  path: string;
  view: "root" | "tree";
}>;

export type GitHubRepositoryPage = {
  head: string;
  listing: DirectoryListing;
};

export type GitHubRefPage = {
  refs: { name: string; sha: string | null }[];
  hasNextPage: boolean;
  nextCursor?: string;
};

export type GitHubRefsPageExpected = Readonly<
  | { kind: "branches"; repository: string; page: number }
  | { kind: "tags"; repository: string; after: string | null }
>;

function fail(): never {
  throw new RepositoryError("compatibility");
}

function requireString(value: unknown, { allowEmpty = false }: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail();
  return value;
}

function requireRecord(value: unknown): object {
  if (typeof value !== "object" || value === null || isArray(value)) fail();
  return value;
}

function ownData(value: object, key: string): unknown {
  const descriptor = getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) fail();
  return descriptor.value;
}

function optionalOwnData(value: object, key: string): unknown {
  const descriptor = getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) fail();
  return descriptor.value;
}

function snapshotArray<T>(value: unknown, maximum: number, snapshot: (item: unknown) => T): T[] {
  if (!isArray(value)) fail();
  const length = ownData(value, "length");
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > maximum) fail();
  const result: T[] = [];
  for (let index = 0; index < length; index++) result[index] = snapshot(ownData(value, String(index)));
  return result;
}

function requireRepository(repository: unknown): string {
  const value = requireString(repository);
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some((part) =>
    part.length === 0 || part === "." || part === ".." ||
    part.includes("\\") || part.includes("?") || part.includes("#") || hasControlCharacter(part))) fail();
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validateSegmentedValue(value: string, { allowEmpty = false }: { allowEmpty?: boolean } = {}): void {
  if (allowEmpty && value === "") return;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." ||
    part.includes("\\") || part.includes("?") || part.includes("#") || hasControlCharacter(part))) fail();
}

function parseDocument(html: unknown): Document {
  if (typeof html !== "string" || html.length === 0 || html.length > GITHUB_MAX_HTML_UNITS) fail();
  return new DOMParser().parseFromString(html, "text/html");
}

function parseJsonObject(text: string): unknown {
  let duplicate = false;
  const parsed = JSON.parse(text) as unknown;
  // JSON.parse cannot expose duplicate-key history to a reviver, so a second
  // strict token pass records object keys without walking the parsed payload.
  const stack: { kind: "object" | "array"; keys: Set<string>; state: "key" | "colon" | "value" | "comma" }[] = [];
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index++; };
  const string = (): string => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    return fail();
  };
  const primitive = () => {
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index++;
    if (start === index) fail();
  };
  const value = (): void => {
    whitespace();
    if (text[index] === '"') { string(); return; }
    if (text[index] === "{") { stack.push({ kind: "object", keys: new Set(), state: "key" }); index++; return; }
    if (text[index] === "[") { stack.push({ kind: "array", keys: new Set(), state: "value" }); index++; return; }
    primitive();
  };
  value();
  while (stack.length > 0) {
    whitespace();
    const frame = stack.at(-1) ?? fail();
    if (frame.kind === "object") {
      if (frame.state === "key") {
        if (text[index] === "}") { stack.pop(); index++; continue; }
        if (text[index] !== '"') fail();
        const key = string();
        if (frame.keys.has(key)) duplicate = true;
        frame.keys.add(key);
        frame.state = "colon";
      } else if (frame.state === "colon") {
        whitespace();
        if (text[index++] !== ":") fail();
        frame.state = "value";
        value();
      } else if (frame.state === "value") {
        frame.state = "comma";
      } else if (text[index] === ",") {
        index++;
        frame.state = "key";
      } else if (text[index] === "}") {
        stack.pop();
        index++;
      } else fail();
    } else if (frame.state === "value") {
      if (text[index] === "]") { stack.pop(); index++; continue; }
      frame.state = "comma";
      value();
    } else if (text[index] === ",") {
      index++;
      frame.state = "value";
    } else if (text[index] === "]") {
      stack.pop();
      index++;
    } else fail();
  }
  whitespace();
  if (index !== text.length || duplicate) fail();
  return parsed;
}

function embeddedPayload(document: Document): unknown {
  if (document.querySelector('form[action="/session"] input[name="login"]')) fail();
  const nodes = document.querySelectorAll(embeddedDataSelector);
  if (nodes.length !== 1) fail();
  const text = nodes[0].textContent;
  if (text === null || text.length === 0) fail();
  return parseJsonObject(text);
}

function requireExpectedPage(value: GitHubExpectedPage): GitHubExpectedPage {
  const record = requireRecord(value);
  const repository = requireRepository(ownData(record, "repository"));
  const ref = ownData(record, "ref");
  const path = requireString(ownData(record, "path"), { allowEmpty: true });
  validateSegmentedValue(path, { allowEmpty: true });
  const view = ownData(record, "view");
  if (view === "root") {
    if (ref !== null || path !== "") fail();
    return { repository, ref: null, path, view };
  }
  if (view !== "tree" || typeof ref !== "string" || ref.length === 0) fail();
  validateSegmentedValue(ref);
  return { repository, ref, path, view };
}

function contentKind(value: unknown): "directory" | "file" | "link" | "submodule" {
  switch (value) {
    case "directory":
    case "file":
    case "link":
    case "submodule":
      return value;
    default:
      return fail();
  }
}

function validateEntryPath(parentPath: string, name: string, path: string): void {
  const expectedPath = parentPath === "" ? name : `${parentPath}/${name}`;
  if (path !== expectedPath || name === "." || name === ".." || name.includes("/") || name.includes("\\")) fail();
}

function decodeRepositoryPage(html: unknown, expectedValue: GitHubExpectedPage): GitHubRepositoryPage {
  const expected = requireExpectedPage(expectedValue);
  const root = requireRecord(embeddedPayload(parseDocument(html)));
  const payload = requireRecord(ownData(root, "payload"));
  const routeKey = expected.view === "root" ? "codeViewRepoRoute" : "codeViewTreeRoute";
  const otherRouteKey = expected.view === "root" ? "codeViewTreeRoute" : "codeViewRepoRoute";
  if (optionalOwnData(payload, otherRouteKey) !== undefined) fail();
  const route = requireRecord(ownData(payload, routeKey));
  const refInfo = requireRecord(ownData(route, "refInfo"));
  const head = requireString(ownData(refInfo, "name"));
  const sha = requireString(ownData(refInfo, "currentOid"));
  const path = requireString(ownData(route, "path"), { allowEmpty: true });
  if ((expected.ref !== null && head !== expected.ref) || path !== expected.path) fail();
  const tree = requireRecord(ownData(route, "tree"));
  const seenPaths = new Set<string>();
  const entries = snapshotArray(ownData(tree, "items"), GITHUB_MAX_ENTRIES, (value) => {
    const item = requireRecord(value);
    const name = requireString(ownData(item, "name"));
    const itemPath = requireString(ownData(item, "path"));
    const kind = contentKind(ownData(item, "contentType"));
    validateEntryPath(path, name, itemPath);
    if (seenPaths.has(itemPath)) fail();
    seenPaths.add(itemPath);
    return { kind, name, path: itemPath, sha: null };
  });
  return { head, listing: { path, sha, entries } };
}

function requireBranchExpected(expectedValue: GitHubRefsPageExpected): { repository: string; page: number } {
  const record = requireRecord(expectedValue);
  if (ownData(record, "kind") !== "branches") fail();
  const repository = requireRepository(ownData(record, "repository"));
  const page = ownData(record, "page");
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) fail();
  return { repository, page };
}

function decodeBranches(html: unknown, expectedValue: GitHubRefsPageExpected): GitHubRefPage {
  const expected = requireBranchExpected(expectedValue);
  const root = requireRecord(embeddedPayload(parseDocument(html)));
  const payload = requireRecord(ownData(root, "payload"));
  const currentPage = ownData(payload, "current_page");
  const hasMore = ownData(payload, "has_more");
  const perPage = ownData(payload, "per_page");
  if (currentPage !== expected.page || typeof hasMore !== "boolean" || perPage !== 100) fail();
  const prefix = `/${expected.repository}/tree/`;
  const refs = snapshotArray(ownData(payload, "branches"), GITHUB_MAX_REFS, (value) => {
    const branch = requireRecord(value);
    const name = requireString(ownData(branch, "name"));
    const path = requireString(ownData(branch, "path"));
    if (path !== `${prefix}${name}`) fail();
    return { name, sha: null };
  });
  const unique = new Map<string, { name: string; sha: null }>();
  for (const ref of refs) if (!unique.has(ref.name)) unique.set(ref.name, ref);
  return { refs: [...unique.values()], hasNextPage: hasMore };
}

function requireTagExpected(expectedValue: GitHubRefsPageExpected): { repository: string; after: string | null } {
  const record = requireRecord(expectedValue);
  if (ownData(record, "kind") !== "tags") fail();
  const repository = requireRepository(ownData(record, "repository"));
  const after = ownData(record, "after");
  if (after !== null && (typeof after !== "string" || after.length === 0)) fail();
  return { repository, after };
}

function attributeValue(element: Element, name: string): string {
  const attribute = element.attributes.getNamedItem(name);
  if (attribute === null) fail();
  return requireString(attribute.value);
}

function decodeTags(html: unknown, expectedValue: GitHubRefsPageExpected): GitHubRefPage {
  const expected = requireTagExpected(expectedValue);
  const document = parseDocument(html);
  if (document.querySelector('form[action="/session"] input[name="login"]')) fail();
  const partials = document.querySelectorAll('rails-partial[data-partial-name="tagsIndexRoute.Results"]');
  if (partials.length !== 1) fail();
  const rows = partials[0].querySelectorAll(".Box-row");
  if (rows.length > GITHUB_MAX_REFS) fail();
  const commitPrefix = `/${expected.repository}/commit/`;
  const releasePrefix = `/${expected.repository}/releases/tag/`;
  const refs = new Map<string, { name: string; sha: string }>();
  for (const row of rows) {
    const nameLinks = row.querySelectorAll("h2 a.Link--primary");
    if (nameLinks.length !== 1) fail();
    const name = requireString(nameLinks[0].textContent);
    if (!attributeValue(nameLinks[0], "href").startsWith(releasePrefix)) fail();
    const commitLinks = [...row.querySelectorAll("a")].filter((link) => {
      const href = link.attributes.getNamedItem("href");
      return href !== null && href.value.startsWith(commitPrefix);
    });
    if (commitLinks.length !== 1) fail();
    const href = attributeValue(commitLinks[0], "href");
    const sha = requireString(href.slice(commitPrefix.length));
    if (sha.includes("/") || sha.includes("?") || sha.includes("#")) fail();
    if (!refs.has(name)) refs.set(name, { name, sha });
  }
  const nextLinks = document.querySelectorAll('a[rel="next"][href*="after="]');
  if (nextLinks.length === 0) return { refs: [...refs.values()], hasNextPage: false };
  if (nextLinks.length !== 1) fail();
  const href = attributeValue(nextLinks[0], "href");
  let url: URL;
  try {
    url = new URL(href, "https://github.com");
  } catch {
    return fail();
  }
  if (url.origin !== "https://github.com" || url.pathname !== `/${expected.repository}/tags` ||
    url.hash !== "" || [...url.searchParams.keys()].some((key) => key !== "after")) fail();
  const cursors = url.searchParams.getAll("after");
  if (cursors.length !== 1 || cursors[0].length === 0) fail();
  return { refs: [...refs.values()], hasNextPage: true, nextCursor: cursors[0] };
}

function decodeSafely<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    return fail();
  }
}

export function decodeGitHubRepositoryPage(
  html: string,
  expected: GitHubExpectedPage,
): GitHubRepositoryPage {
  return decodeSafely(() => decodeRepositoryPage(html, expected));
}

export function decodeGitHubRefsPage(
  html: string,
  expected: GitHubRefsPageExpected,
): GitHubRefPage {
  return decodeSafely(() => {
    const record = requireRecord(expected);
    const kind = ownData(record, "kind");
    if (kind === "branches") return decodeBranches(html, expected);
    if (kind === "tags") return decodeTags(html, expected);
    return fail();
  });
}
