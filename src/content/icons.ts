export type PanelIcon = "folder" | "file" | "link" | "submodule" | "search" | "refresh" | "close" | "chevron" | "branch" | "tag";

// Original 16px line drawings; repository text is never part of SVG markup.
const paths: Record<PanelIcon, string> = {
  folder: "M2 4h4l1.5 2H14v7H2Z M2 4V3h4l1.5 2H14v1",
  file: "M4 2h5l3 3v9H4Z M9 2v4h3 M6 9h4 M6 11h3",
  link: "M6 10 10 6 M5 8 3.5 9.5a2 2 0 0 0 3 3L8 11 M8 5l1.5-1.5a2 2 0 0 1 3 3L11 8",
  submodule: "M2 4h4l1.5 2H14v7H2Z M7 8l2 2-2 2 M10 10h2",
  search: "M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M10 10l3.5 3.5",
  refresh: "M13 6a5 5 0 1 0 0 4 M13 2v4H9",
  close: "M4 4l8 8 M12 4l-8 8",
  chevron: "M6 3l5 5-5 5",
  branch: "M4 5v6 M4 8h4a4 4 0 0 0 4-4 M6 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z M6 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z M14 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  tag: "M2 2h6l6 6-6 6-6-6Z M6 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
};

export function createPanelIcon(document: Document, name: PanelIcon): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
