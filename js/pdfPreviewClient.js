/**
 * Draws a PDF into a container. Chrome's built-in viewer is not used: when
 * Chrome is set to download PDFs, an iframe shows "This content is blocked."
 *
 * Pages outside the viewport stay as empty slots until scrolled into view, so
 * a long file does not allocate a canvas for every page at once.
 */
import * as pdfjs from "pdfjs-dist";

const WORKER_SRC = "js/pdf/pdf.worker.min.js";
const MAX_PIXEL_RATIO = 2;
const MAX_CANVAS_PIXELS = 6_000_000;
const sessions = new WeakMap();

function scriptBaseHref() {
  try {
    const openerHref = window.opener?.location?.href;
    if (openerHref && !openerHref.startsWith("about:")) return openerHref;
  } catch {
    /* The opener is not readable. */
  }
  const base = document.baseURI || window.location.href;
  if (base && !base.startsWith("about:")) return base;
  return window.location.href;
}

pdfjs.GlobalWorkerOptions.workerSrc = new URL(WORKER_SRC, scriptBaseHref()).href;

function alive(session) {
  return !session.dropped && session.container?.isConnected;
}

function releaseDocument(session) {
  if (!session || session.docReleased) return;
  session.docReleased = true;
  session.observer?.disconnect();
  session.domObserver?.disconnect();
  session.observer = null;
  session.domObserver = null;
  const pdf = session.pdf;
  session.pdf = null;
  pdf?.destroy?.().catch(() => {});
}

function dropSession(session) {
  if (!session || session.dropped) return;
  session.dropped = true;
  try {
    session.renderTask?.cancel();
  } catch {
    /* The page already finished drawing. */
  }
  session.renderTask = null;
  session.loadingTask?.destroy?.();
  session.loadingTask = null;
  if (session.container) sessions.delete(session.container);
  releaseDocument(session);
  session.container = null;
}

function watchRemoval(container, session) {
  const parent = container.parentElement;
  if (!parent) return;
  const observer = new MutationObserver(() => {
    if (!container.isConnected) dropSession(session);
  });
  observer.observe(parent, { childList: true });
  session.domObserver = observer;
}

function contentWidth(container) {
  const width = container.clientWidth;
  if (width >= 64) return width;
  const parent = container.parentElement?.clientWidth || 0;
  if (parent >= 64) return parent;
  return 720;
}

function fitViewport(page, cssWidth, pixelRatio) {
  const base = page.getViewport({ scale: 1 });
  let scale = (cssWidth / base.width) * pixelRatio;
  let viewport = page.getViewport({ scale });
  const pixels = viewport.width * viewport.height;
  if (pixels > MAX_CANVAS_PIXELS) {
    scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    viewport = page.getViewport({ scale });
  }
  return viewport;
}

function makeSlot(doc, page) {
  const base = page.getViewport({ scale: 1 });
  const slot = doc.createElement("div");
  slot.className = "pdf-preview-slot";
  slot.style.aspectRatio = `${base.width} / ${base.height}`;
  return slot;
}

async function drawPage(session, page, slot) {
  if (!alive(session)) return false;
  const doc = slot.ownerDocument;
  const ratio = Math.min(Math.max(doc.defaultView?.devicePixelRatio || 1, 1), MAX_PIXEL_RATIO);
  const viewport = fitViewport(page, contentWidth(session.container), ratio);
  const canvas = doc.createElement("canvas");
  canvas.className = "pdf-preview-page";
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { alpha: false }) || canvas.getContext("2d");
  if (!context) throw new Error("Could not draw the PDF.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  slot.replaceChildren(canvas);
  const task = page.render({ canvasContext: context, viewport });
  session.renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (!alive(session) || err?.name === "RenderingCancelledException") return false;
    throw err;
  } finally {
    if (session.renderTask === task) session.renderTask = null;
    page.cleanup();
  }
  return alive(session);
}

function enqueue(session, page, slot) {
  const job = session.tail.then(async () => {
    if (!alive(session) || session.failed) return;
    try {
      const painted = await drawPage(session, page, slot);
      if (!painted || !alive(session)) return;
    } catch (err) {
      if (!alive(session)) return;
      session.failed = true;
      slot.textContent = "This page could not be drawn.";
      throw err;
    }
    session.drawn += 1;
    if (session.drawn >= session.pageCount) releaseDocument(session);
  });
  session.tail = job.catch(() => {});
  return job;
}

async function render(container, blob) {
  if (!container) throw new Error("PDF preview container is missing.");
  dropSession(sessions.get(container));
  const session = {
    container,
    dropped: false,
    failed: false,
    docReleased: false,
    drawn: 0,
    pageCount: 0,
    tail: Promise.resolve(),
    pdf: null,
    loadingTask: null,
    renderTask: null,
    observer: null,
    domObserver: null,
  };
  sessions.set(container, session);
  watchRemoval(container, session);

  const data = await blob.arrayBuffer();
  if (session.dropped) return;
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableStream: true,
    disableAutoFetch: true,
  });
  session.loadingTask = loadingTask;
  try {
    const pdf = await loadingTask.promise;
    if (!alive(session)) {
      pdf.destroy().catch(() => {});
      return;
    }
    session.pdf = pdf;
  } catch (err) {
    if (session.dropped) return;
    throw err;
  } finally {
    session.loadingTask = null;
  }
  if (!alive(session) || !session.pdf) return;

  const pdf = session.pdf;
  if (!pdf.numPages) throw new Error("This PDF has no pages.");
  session.pageCount = pdf.numPages;
  container.replaceChildren();

  const doc = container.ownerDocument;
  session.pages = new Map();
  session.observer = new IntersectionObserver(
    (entries) => {
      if (!alive(session)) {
        dropSession(session);
        return;
      }
      entries.forEach((entry) => {
        if (!entry.isIntersecting || session.docReleased || !session.pdf) return;
        session.observer?.unobserve(entry.target);
        const page = session.pages?.get(entry.target);
        if (page) enqueue(session, page, entry.target).catch(() => {});
      });
    },
    { rootMargin: "800px 0px" }
  );

  const first = await loadPage(session, pdf, 1);
  if (!first || !alive(session)) return;
  const firstSlot = makeSlot(doc, first);
  container.appendChild(firstSlot);
  const firstDraw = enqueue(session, first, firstSlot);
  firstDraw.catch(() => {});

  for (let number = 2; number <= pdf.numPages; number += 1) {
    if (!alive(session)) return;
    const page = await loadPage(session, pdf, number);
    if (!page || !alive(session)) return;
    const slot = makeSlot(doc, page);
    container.appendChild(slot);
    session.pages.set(slot, page);
    session.observer.observe(slot);
  }
  try {
    await firstDraw;
  } catch (err) {
    if (!alive(session)) return;
    throw err;
  }
}

async function loadPage(session, pdf, number) {
  try {
    return await pdf.getPage(number);
  } catch (err) {
    if (!alive(session)) return null;
    throw err;
  }
}

window.PdfPreview = { render };
