/*
* format-html-bootstrap.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { Document, Element } from "../../core/deno-dom.ts";
import { join } from "path/mod.ts";

import { renderEjs } from "../../core/ejs.ts";
import { formatResourcePath } from "../../core/resources.ts";

import {
  kCitationLocation,
  kHtmlMathMethod,
  kLinkCitations,
  kReferenceLocation,
  kSectionDivs,
  kTheme,
} from "../../config/constants.ts";
import {
  Format,
  FormatExtras,
  kBodyEnvelope,
  kDependencies,
  kHtmlPostprocessors,
  kSassBundles,
  Metadata,
} from "../../config/types.ts";
import { isHtmlOutput } from "../../config/format.ts";
import { PandocFlags } from "../../config/types.ts";
import { hasTableOfContents } from "../../config/toc.ts";

import { resolveBootstrapScss } from "./format-html-scss.ts";
import {
  insertFootnotesTitle,
  kBootstrapDependencyName,
  kDocumentCss,
  kPageLayout,
  kPageLayoutArticle,
  kPageLayoutCustom,
  kPageLayoutListing,
  kPageLayoutNone,
} from "./format-html-shared.ts";

export function formatHasBootstrap(format: Format) {
  if (format && isHtmlOutput(format.pandoc, true)) {
    return hasBootstrapTheme(format.metadata);
  } else {
    return false;
  }
}

export function hasBootstrapTheme(metadata: Metadata) {
  const theme = metadata[kTheme];
  return theme !== "none" && theme !== "pandoc";
}

// Returns a boolean indicating whether dark mode is requested
// (true or false) or undefined if the dark mode support isn't present
// Key order determines whether dark mode is true or false
export function formatDarkMode(format: Format): boolean | undefined {
  const isBootstrap = formatHasBootstrap(format);
  if (isBootstrap) {
    return darkModeDefault(format.metadata);
  }
  return undefined;
}

function darkModeDefault(metadata?: Metadata): boolean | undefined {
  if (metadata !== undefined) {
    const theme = metadata[kTheme];
    if (theme && typeof (theme) === "object") {
      const keys = Object.keys(theme);
      if (keys.includes("dark")) {
        if (keys[0] === "dark") {
          return true;
        } else {
          return false;
        }
      }
    }
  }
  return undefined;
}

export function formatPageLayout(format: Format) {
  return format.metadata[kPageLayout] || kPageLayoutArticle;
}

export function formatHasPageLayout(format: Format) {
  return format.metadata[kPageLayout] === undefined ||
    format.metadata[kPageLayout] !== kPageLayoutNone;
}

export function formatHasArticlePageLayout(format: Format) {
  return format.metadata[kPageLayout] === undefined ||
    format.metadata[kPageLayout] === kPageLayoutArticle ||
    format.metadata[kPageLayout] === kPageLayoutListing;
}

export function formatHasCustomPageLayout(format: Format) {
  return format.metadata[kPageLayout] == kPageLayoutCustom;
}

export function bootstrapFormatDependency() {
  const boostrapResource = (resource: string) =>
    formatResourcePath(
      "html",
      join("bootstrap", "dist", resource),
    );
  const bootstrapDependency = (resource: string) => ({
    name: resource,
    path: boostrapResource(resource),
  });

  return {
    name: kBootstrapDependencyName,
    stylesheets: [
      bootstrapDependency("bootstrap-icons.css"),
    ],
    scripts: [
      bootstrapDependency("bootstrap.min.js"),
    ],
    resources: [
      bootstrapDependency("bootstrap-icons.woff"),
    ],
  };
}

export function boostrapExtras(
  input: string,
  flags: PandocFlags,
  format: Format,
): FormatExtras {
  const toc = hasTableOfContents(flags, format);

  const renderTemplate = (template: string, pageLayout: string) => {
    return renderEjs(formatResourcePath("html", `templates/${template}`), {
      toc,
      pageLayout,
    });
  };

  const bodyEnvelope = formatHasArticlePageLayout(format)
    ? {
      before: renderTemplate("before-body-article.ejs", kPageLayoutArticle),
      afterPreamble: renderTemplate(
        "after-body-article-preamble.ejs",
        kPageLayoutArticle,
      ),
      afterPostamble: renderTemplate(
        "after-body-article-postamble.ejs",
        kPageLayoutArticle,
      ),
    }
    : formatHasCustomPageLayout(format)
    ? {
      before: renderTemplate("before-body-custom.ejs", kPageLayoutCustom),
      afterPreamble: renderTemplate(
        "after-body-custom-preamble.ejs",
        kPageLayoutCustom,
      ),
      afterPostamble: renderTemplate(
        "after-body-custom-postamble.ejs",
        kPageLayoutCustom,
      ),
    }
    : undefined;

  return {
    pandoc: {
      [kSectionDivs]: true,
      [kHtmlMathMethod]: "mathjax",
    },
    metadata: {
      [kDocumentCss]: false,
      [kLinkCitations]: true,
    },
    html: {
      [kSassBundles]: resolveBootstrapScss(input, format),
      [kDependencies]: [bootstrapFormatDependency()],
      [kBodyEnvelope]: bodyEnvelope,
      [kHtmlPostprocessors]: [
        bootstrapHtmlPostprocessor(flags, format),
      ],
    },
  };
}

function bootstrapHtmlPostprocessor(flags: PandocFlags, format: Format) {
  return (doc: Document): Promise<string[]> => {
    // use display-7 style for title
    const title = doc.querySelector("header > .title");
    if (title) {
      title.classList.add("display-7");
    }

    // Process captions that may appear in the margin
    processMarginCaptions(doc);

    // Group margin elements by their parents and wrap them in a container
    // Be sure to ignore containers which are already processed
    // and should be left alone
    const marginProcessors: MarginNodeProcessor[] = [
      simpleMarginProcessor,
    ];
    // If margin footnotes are enabled move them
    const refsInMargin = format.pandoc[kReferenceLocation] === "margin" ||
      flags[kReferenceLocation] === "margin";
    if (refsInMargin) {
      marginProcessors.push(footnoteMarginProcessor);
    }

    // If margin cites are enabled, move them
    const citesInMargin = format.metadata[kCitationLocation] === "margin";
    if (citesInMargin) {
      marginProcessors.push(referenceMarginProcessor);
    }
    processMarginNodes(doc, marginProcessors);

    // Find any elements that are using fancy layouts (columns)
    const columnLayouts = doc.querySelectorAll(
      '[class^="column-"], [class*=" column-"], aside, [class*="margin-caption"], [class*=" margin-caption"], [class*="margin-ref"], [class*=" margin-ref"]',
    );
    // If there are any of these elements, we need to be sure that their
    // parents have acess to the grid system, so make the parent full screen width
    // and apply the grid system to it (now the child 'column-' element can be positioned
    // anywhere in the grid system)
    if (columnLayouts && columnLayouts.length > 0) {
      const ensureInGrid = (el: Element, setLayout: boolean) => {
        // Add the grid system. Children of the grid system
        // are placed into the body-content column by default
        // (CSS implements this)
        if (!el.classList.contains("page-columns")) {
          el.classList.add("page-columns");
        }

        // Mark full width
        if (setLayout && !el.classList.contains("page-full")) {
          el.classList.add("page-full");
        }

        // Process parents up to the main tag
        if (el.tagName !== "MAIN") {
          const parent = el.parentElement;
          if (parent) {
            ensureInGrid(parent, true);
          }
        }
      };

      columnLayouts.forEach((node) => {
        const el = node as Element;
        if (el.parentElement) {
          ensureInGrid(el.parentElement, true);
        }
      });
    }

    // add 'lead' to subtitle
    const subtitle = doc.querySelector("header > .subtitle");
    if (subtitle) {
      subtitle.classList.add("lead");
    }

    // add 'blockquote' class to blockquotes
    const blockquotes = doc.querySelectorAll("blockquote");
    for (let i = 0; i < blockquotes.length; i++) {
      const classList = (blockquotes[i] as Element).classList;
      classList.add("blockquote");
    }

    // add figure classes to figures
    const figures = doc.querySelectorAll("figure");
    for (let i = 0; i < figures.length; i++) {
      const figure = (figures[i] as Element);
      figure.classList.add("figure");
      const images = figure.querySelectorAll("img");
      for (let j = 0; j < images.length; j++) {
        (images[j] as Element).classList.add("figure-img");
      }
      const captions = figure.querySelectorAll("figcaption");
      for (let j = 0; j < captions.length; j++) {
        (captions[j] as Element).classList.add("figure-caption");
      }
    }

    // move the toc if there is a sidebar
    const toc = doc.querySelector('nav[role="doc-toc"]');

    const tocTarget = doc.getElementById("quarto-toc-target");
    if (toc && tocTarget) {
      // add nav-link class to the TOC links
      const tocLinks = doc.querySelectorAll('nav[role="doc-toc"] > ul a');
      for (let i = 0; i < tocLinks.length; i++) {
        // Mark the toc links as nav-links
        const tocLink = tocLinks[i] as Element;
        tocLink.classList.add("nav-link");
        if (i === 0) {
          tocLink.classList.add("active");
        }

        // move the raw href to the target attribute (need the raw value, not the full path)
        if (!tocLink.hasAttribute("data-scroll-target")) {
          tocLink.setAttribute(
            "data-scroll-target",
            tocLink.getAttribute("href")?.replaceAll(":", "\\:"),
          );
        }
      }

      // default collapse non-top level TOC nodes
      const nestedUls = toc.querySelectorAll("ul ul");
      for (let i = 0; i < nestedUls.length; i++) {
        const ul = nestedUls[i] as Element;
        ul.classList.add("collapse");
      }
      toc.remove();
      tocTarget.replaceWith(toc);
    }

    // add .table class to pandoc tables
    const tableHeaders = doc.querySelectorAll("tbody > tr:first-child.odd");
    for (let i = 0; i < tableHeaders.length; i++) {
      const th = tableHeaders[i];
      if (th.parentNode?.parentNode) {
        const table = th.parentNode.parentNode as Element;
        table.removeAttribute("style");
        table.classList.add("table");
      }
    }

    // add .table class to pandas tables
    const pandasTables = doc.querySelectorAll("table.dataframe");
    for (let i = 0; i < pandasTables.length; i++) {
      const table = pandasTables[i] as Element;
      table.removeAttribute("border");
      table.classList.add("table");
      const headerRows = table.querySelectorAll("tr");
      for (let r = 0; r < headerRows.length; r++) {
        (headerRows[r] as Element).removeAttribute("style");
      }
      if (
        table.previousElementSibling &&
        table.previousElementSibling.tagName === "STYLE"
      ) {
        table.previousElementSibling.remove();
      }
    }

    // provide data-anchor-id to headings
    const sections = doc.querySelectorAll('section[class^="level"]');
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i] as Element;
      const heading = section.querySelector("h2") ||
        section.querySelector("h3") || section.querySelector("h4") ||
        section.querySelector("h5") || section.querySelector("h6");
      if (heading) {
        heading.setAttribute("data-anchor-id", section.id);
      }
    }

    // provide heading for footnotes (but only if there is one section, there could
    // be multiple if they used reference-location: block/section)
    const footnotes = doc.querySelectorAll('section[role="doc-endnotes"]');
    if (refsInMargin) {
      const footNoteSectionEl = doc.querySelector("section.footnotes");
      if (footNoteSectionEl) {
        footNoteSectionEl.remove();
      }
    } else if (footnotes.length === 1) {
      const footnotesEl = footnotes.item(0) as Element;
      insertFootnotesTitle(doc, footnotesEl, format.language);
    }

    // Purge the bibliography if we're using refs in margin
    if (citesInMargin) {
      const bibliographyDiv = doc.querySelector("div#refs");
      if (bibliographyDiv) {
        bibliographyDiv.remove();
      }
    }

    // Note whether we need a narrow or wide margin layout
    if (format.metadata[kPageLayout] === kPageLayoutListing) {
      doc.body.classList.add("listing");
    }

    const leftSidebar = doc.getElementById("quarto-sidebar");
    const rightSidebar = doc.getElementById("quarto-margin-sidebar");
    if (columnLayouts.length > 0 && leftSidebar) {
      // wide margin b/c there are margin elements
      doc.body.classList.add("slimcontent");
    } else if (rightSidebar) {
      // there is a toc, default layout
    } else {
      // no toc, narrow body to preserve readability
      doc.body.classList.add("fullcontent");
    }

    // no resource refs
    return Promise.resolve([]);
  };
}

const processMarginNodes = (
  doc: Document,
  processors: MarginNodeProcessor[],
) => {
  const marginSelector = processors.map((proc) => proc.selector).join(
    ", ",
  );
  const marginNodes = doc.querySelectorAll(marginSelector);
  marginNodes.forEach((marginNode) => {
    const marginEl = marginNode as Element;
    for (const processor of processors) {
      if (processor.canProcess(marginEl)) {
        processor.process(marginEl, doc);
        break;
      }
    }
    marginEl.classList.remove("column-margin");
  });
};

const findQuartoFigure = (el: Element): Element | undefined => {
  if (el.classList.contains("quarto-figure")) {
    return el;
  } else if (el.parentElement) {
    return findQuartoFigure(el.parentElement);
  } else {
    return undefined;
  }
};

const moveClassToCaption = (container: Element, sel: string) => {
  const target = container.querySelector(sel);
  if (target) {
    target.classList.add("margin-caption");
    return true;
  } else {
    return false;
  }
};

const removeCaptionClass = (el: Element) => {
  // Remove this since it will place the contents in the margin if it remains present
  el.classList.remove("margin-caption");
};

const processLayoutPanelMarginCaption = (captionContainer: Element) => {
  const figure = captionContainer.querySelector("figure");
  if (figure) {
    // It is a figure panel, find a direct child caption of the outer figure.
    for (const child of figure.children) {
      if (child.tagName === "FIGCAPTION") {
        child.classList.add("margin-caption");
        removeCaptionClass(captionContainer);
        break;
      }
    }
  } else {
    // it is not a figure panel, find the panel caption
    const caption = captionContainer.querySelector(".panel-caption");
    if (caption) {
      caption.classList.add("margin-caption");
      removeCaptionClass(captionContainer);
    }
  }
};

const processFigureMarginCaption = (
  captionContainer: Element,
  doc: Document,
) => {
  // First try finding a fig caption
  const foundCaption = moveClassToCaption(captionContainer, "figcaption");
  if (!foundCaption) {
    // find a table caption and copy the contents into a div with style figure-caption
    // note that for tables, our grid inception approach isn't going to work, so
    // we make a copy of the caption contents and place that in the same container as the
    // table and bind it to the grid
    const captionEl = captionContainer.querySelector("caption");
    if (captionEl) {
      const parentDivEl = captionEl?.parentElement?.parentElement;
      if (parentDivEl) {
        captionEl.classList.add("hidden");

        const divCopy = doc.createElement("div");
        divCopy.classList.add("figure-caption");
        divCopy.classList.add("margin-caption");
        divCopy.innerHTML = captionEl.innerHTML;
        parentDivEl.appendChild(divCopy);
        removeCaptionClass(captionContainer);
      }
    }
  } else {
    removeCaptionClass(captionContainer);
  }
};

// Process any captions that appear in margins
const processMarginCaptions = (doc: Document) => {
  // Forward caption class from parents to the child fig caps
  const marginCaptions = doc.querySelectorAll(".margin-caption");
  marginCaptions.forEach((node) => {
    const figureEl = node as Element;
    const captionContainer = findQuartoFigure(figureEl);
    if (captionContainer) {
      // Deal with layout panels (we will only handle the main caption not the internals)
      const isLayoutPanel = captionContainer.classList.contains(
        "quarto-layout-panel",
      );
      if (isLayoutPanel) {
        processLayoutPanelMarginCaption(captionContainer);
      } else {
        processFigureMarginCaption(captionContainer, doc);
      }
    }
    removeCaptionClass(figureEl);
  });
};

interface MarginNodeProcessor {
  selector: string;
  canProcess(el: Element): boolean;
  process(el: Element, doc: Document): void;
}

const simpleMarginProcessor: MarginNodeProcessor = {
  selector: ".column-margin:not(.column-container)",
  canProcess(el: Element) {
    return el.classList.contains("column-margin") &&
      !el.classList.contains("column-container");
  },
  process(el: Element, doc: Document) {
    el.classList.remove("column-margin");
    addContentToMarginContainerForEl(el, el, doc);
  },
};

const footnoteMarginProcessor: MarginNodeProcessor = {
  selector: ".footnote-ref",
  canProcess(el: Element) {
    return el.classList.contains("footnote-ref");
  },
  process(el: Element, doc: Document) {
    if (el.hasAttribute("href")) {
      const target = el.getAttribute("href");
      if (target) {
        // First try to grab a the citation or footnote.
        const refId = target.slice(1);
        const refContentsEl = doc.getElementById(refId);
        if (refContentsEl) {
          // Find and remove the backlink
          const backLinkEl = refContentsEl.querySelector(".footnote-back");
          if (backLinkEl) {
            backLinkEl.remove();
          }

          // Prepend the footnote mark
          if (refContentsEl.childNodes.length > 0) {
            const firstChild = refContentsEl.childNodes[0];
            // Prepend the reference identified (e.g. <sup>1</sup> and a non breaking space)
            firstChild.insertBefore(
              doc.createTextNode("\u00A0"),
              firstChild.firstChild,
            );

            firstChild.insertBefore(
              el.firstChild.cloneNode(true),
              firstChild.firstChild,
            );
          }
          addContentToMarginContainerForEl(el, refContentsEl, doc);
        }
      }
    }
  },
};

const referenceMarginProcessor: MarginNodeProcessor = {
  selector: "a[role='doc-biblioref']",
  canProcess(el: Element) {
    return el.hasAttribute("role") &&
      el.getAttribute("role") === "doc-biblioref";
  },
  process(el: Element, doc: Document) {
    if (el.hasAttribute("href")) {
      const target = el.getAttribute("href");
      if (target) {
        // First try to grab a the citation or footnote.
        const refId = target.slice(1);
        const refContentsEl = doc.getElementById(refId);
        if (refContentsEl && el.parentElement) {
          addContentToMarginContainerForEl(
            el.parentElement,
            refContentsEl.cloneNode(true),
            doc,
          );
        }
      }
    }
  },
};

// Tests whether element is a margin container
const isContainer = (el: Element | null) => {
  return (
    el &&
    el.tagName === "DIV" &&
    el.classList.contains("column-container") &&
    el.classList.contains("column-margin")
  );
};

const isAlreadyInMargin = (el: Element): boolean => {
  const elInMargin = el.classList.contains("column-margin") ||
    el.classList.contains("aside") || el.classList.contains("margin-caption");
  if (elInMargin) {
    return true;
  } else if (el.parentElement !== null) {
    return isAlreadyInMargin(el.parentElement);
  } else {
    return false;
  }
};

// Creates a margin container
const createMarginContainer = (doc: Document) => {
  const container = doc.createElement("div");
  container.classList.add("no-row-height");
  container.classList.add("column-margin");
  container.classList.add("column-container");
  return container;
};

const marginContainerForEl = (el: Element, doc: Document) => {
  // The elements direct parent is in the margin
  if (el.parentElement && isAlreadyInMargin(el.parentElement)) {
    return el.parentElement;
  }

  // If the container would be directly adjacent to another container
  // we should use that adjacent container
  if (el.nextElementSibling && isContainer(el.nextElementSibling)) {
    return el.nextElementSibling;
  }
  if (el.previousElementSibling && isContainer(el.previousElementSibling)) {
    return el.previousElementSibling;
  }

  // Check for a list or table
  const list = findOutermostParentElOfType(el, ["OL", "UL", "TABLE"]);
  if (list) {
    if (list.nextElementSibling && isContainer(list.nextElementSibling)) {
      return list.nextElementSibling;
    } else {
      const container = createMarginContainer(doc);
      if (list.parentNode) {
        list.parentNode.insertBefore(container, list.nextElementSibling);
      }
      return container;
    }
  }

  // Deal with a paragraph
  const parentEl = el.parentElement;
  const cantContainBlockTags = ["P"];
  if (parentEl && cantContainBlockTags.includes(parentEl.tagName)) {
    // See if this para has a parent div with a container
    if (
      parentEl.parentElement &&
      parentEl.parentElement.tagName === "DIV" &&
      parentEl.nextElementSibling &&
      isContainer(parentEl.nextElementSibling)
    ) {
      return parentEl.nextElementSibling;
    } else {
      const container = createMarginContainer(doc);
      const wrapper = doc.createElement("div");
      parentEl.replaceWith(wrapper);
      wrapper.appendChild(parentEl);
      wrapper.appendChild(container);
      return container;
    }
  }

  // We couldn't find a container, so just cook one up and return
  const container = createMarginContainer(doc);
  el.parentNode?.insertBefore(container, el.nextElementSibling);
  return container;
};

const addContentToMarginContainerForEl = (
  el: Element,
  content: Element,
  doc: Document,
) => {
  const container = marginContainerForEl(el, doc);
  if (container) {
    container.appendChild(content);
  }
};

const findOutermostParentElOfType = (
  el: Element,
  tagNames: string[],
): Element | undefined => {
  let outEl = undefined;
  if (el.parentElement) {
    if (el.parentElement.tagName === "MAIN") {
      return outEl;
    } else {
      if (tagNames.includes(el.parentElement.tagName)) {
        outEl = el.parentElement;
      }
      outEl = findOutermostParentElOfType(el.parentElement, tagNames) || outEl;
      return outEl;
    }
  } else {
    return undefined;
  }
};
