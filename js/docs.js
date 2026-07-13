/**
 * Futuristic docs portal — search, command palette, copy, accordions
 */
(function () {
  "use strict";

  const COPY_FEEDBACK_MS = 1800;

  /* ── Copy buttons ── */
  function initCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const text = btn.getAttribute("data-copy") || btn.closest(".docs-cmd-block")?.querySelector("pre")?.textContent;
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text.trim());
          btn.classList.add("copied");
          const prev = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.classList.remove("copied");
            btn.textContent = prev;
          }, COPY_FEEDBACK_MS);
        } catch {
          btn.textContent = "Failed";
        }
      });
    });
  }

  /* ── Recipe accordions ── */
  function initRecipes() {
    document.querySelectorAll(".docs-recipe-header").forEach((header) => {
      header.addEventListener("click", () => {
        header.closest(".docs-recipe")?.classList.toggle("open");
      });
    });
  }

  /* ── Quick-start step details ── */
  function initSteps() {
    const detail = document.getElementById("step-detail");
    if (!detail) return;

    document.querySelectorAll(".docs-step[data-step]").forEach((step) => {
      step.addEventListener("click", () => {
        const id = step.getAttribute("data-step");
        const template = document.getElementById(`step-content-${id}`);
        if (!template) return;

        const isOpen = step.classList.contains("open");
        document.querySelectorAll(".docs-step").forEach((s) => s.classList.remove("open"));

        if (isOpen) {
          detail.classList.remove("open");
          detail.innerHTML = "";
          return;
        }

        step.classList.add("open");
        detail.classList.add("open");
        detail.innerHTML = template.innerHTML;
        initCopyButtons();
        detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  /* ── Search filter ── */
  function initSearch() {
    const input = document.getElementById("docs-search");
    if (!input) return;

    const filterable = () =>
      document.querySelectorAll("[data-search]");

    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      filterable().forEach((el) => {
        const hay = (el.getAttribute("data-search") || el.textContent || "").toLowerCase();
        el.setAttribute("data-hidden", q && !hay.includes(q) ? "true" : "false");
      });
    });
  }

  /* ── Command palette (⌘K / Ctrl+K) ── */
  const PALETTE_ITEMS = [
    { label: "Run locally", cmd: "npm run dev", action: () => scrollTo("#quickstart") },
    { label: "Sync prod → staging", cmd: "./scripts/db.sh sync", action: () => scrollTo("#release") },
    { label: "Preflight migrations", cmd: "./scripts/db.sh migrate", action: () => scrollTo("#commands") },
    { label: "Apply prod migrations", cmd: "./scripts/db.sh migrate --apply", action: () => scrollTo("#commands") },
    { label: "Backup production", cmd: "./scripts/db.sh backup", action: () => scrollTo("#commands") },
    { label: "Deploy staging", cmd: "git push origin staging", action: () => scrollTo("#commands") },
    { label: "Architecture docs", cmd: "view.html?doc=ARCHITECTURE", action: () => (location.href = "view.html?doc=ARCHITECTURE") },
    { label: "Flows docs", cmd: "view.html?doc=FLOWS", action: () => (location.href = "view.html?doc=FLOWS") },
    { label: "Data tables", cmd: "view.html?doc=DATA_TABLES", action: () => (location.href = "view.html?doc=DATA_TABLES") },
    { label: "Development guide", cmd: "view.html?doc=DEVELOPMENT", action: () => (location.href = "view.html?doc=DEVELOPMENT") },
  ];

  function scrollTo(sel) {
    document.querySelector(sel)?.scrollIntoView({ behavior: "smooth" });
  }

  function initPalette() {
    const overlay = document.getElementById("docs-palette");
    const paletteInput = document.getElementById("palette-input");
    const results = document.getElementById("palette-results");
    if (!overlay || !paletteInput || !results) return;

    let focusIdx = 0;
    let filtered = [...PALETTE_ITEMS];

    function renderPalette(list) {
      results.innerHTML = "";
      list.forEach((item, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "docs-palette-item" + (i === focusIdx ? " focused" : "");
        btn.innerHTML = `<span>${item.label}</span><span>${item.cmd}</span>`;
        btn.addEventListener("click", () => {
          closePalette();
          item.action();
        });
        results.appendChild(btn);
      });
    }

    function openPalette() {
      overlay.classList.add("open");
      paletteInput.value = "";
      filtered = [...PALETTE_ITEMS];
      focusIdx = 0;
      renderPalette(filtered);
      paletteInput.focus();
    }

    function closePalette() {
      overlay.classList.remove("open");
    }

    paletteInput.addEventListener("input", () => {
      const q = paletteInput.value.trim().toLowerCase();
      filtered = PALETTE_ITEMS.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.cmd.toLowerCase().includes(q)
      );
      focusIdx = 0;
      renderPalette(filtered);
    });

    paletteInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusIdx = Math.min(focusIdx + 1, filtered.length - 1);
        renderPalette(filtered);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusIdx = Math.max(focusIdx - 1, 0);
        renderPalette(filtered);
      } else if (e.key === "Enter" && filtered[focusIdx]) {
        e.preventDefault();
        closePalette();
        filtered[focusIdx].action();
      } else if (e.key === "Escape") {
        closePalette();
      }
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closePalette();
    });

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openPalette();
      }
      if (e.key === "Escape") closePalette();
    });

    const searchInput = document.getElementById("docs-search");
    searchInput?.addEventListener("focus", () => {
      if (!searchInput.value) openPalette();
    });
  }

  /* ── Sidebar active section ── */
  function initSidebarSpy() {
    const links = document.querySelectorAll(".docs-nav a[href^='#']");
    if (!links.length) return;

    const sections = [...links]
      .map((a) => document.querySelector(a.getAttribute("href")))
      .filter(Boolean);

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((a) => {
            a.classList.toggle("active", a.getAttribute("href") === `#${entry.target.id}`);
          });
        });
      },
      { rootMargin: "-20% 0px -70% 0px" }
    );

    sections.forEach((s) => observer.observe(s));
  }

  /* ── Mobile sidebar ── */
  function initMobileNav() {
    const toggle = document.getElementById("docs-mobile-toggle");
    const sidebar = document.querySelector(".docs-sidebar");
    if (!toggle || !sidebar) return;

    toggle.addEventListener("click", () => sidebar.classList.toggle("open"));
    sidebar.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => sidebar.classList.remove("open"));
    });
  }

  /* ── Markdown viewer ── */
  async function initViewer() {
    const container = document.getElementById("docs-markdown");
    if (!container) return;

    const params = new URLSearchParams(location.search);
    const doc = params.get("doc") || "README";
    const file = doc === "README" ? "README.md" : `${doc}.md`;

    document.title = `${doc.replace(/_/g, " ")} — Docs`;

    const titleEl = document.getElementById("viewer-title");
    if (titleEl) titleEl.textContent = doc.replace(/_/g, " ");

    try {
      const res = await fetch(file);
      if (!res.ok) throw new Error("Not found");
      let md = await res.text();

      // Strip hub pointer line if present
      md = md.replace(/^> \*\*Quick.*\n\n/m, "");

      if (typeof marked !== "undefined") {
        marked.setOptions({ gfm: true, breaks: false });
        container.innerHTML = marked.parse(md);
        container.classList.add("docs-markdown");

        // Rewrite .md links to view.html
        container.querySelectorAll("a[href$='.md']").forEach((a) => {
          const href = a.getAttribute("href");
          const name = href.replace(/^\.\//, "").replace(/\.md$/, "").replace(/.*\//, "");
          if (name === "README") {
            a.setAttribute("href", "index.html");
          } else if (href.startsWith("../scripts/")) {
            a.setAttribute("target", "_blank");
          } else {
            a.setAttribute("href", `view.html?doc=${name}`);
          }
        });

        container.querySelectorAll("a[href^='#']").forEach((a) => {
          a.addEventListener("click", (e) => {
            const id = a.getAttribute("href").slice(1);
            const target = container.querySelector(`[id='${CSS.escape(id)}']`);
            if (target) {
              e.preventDefault();
              target.scrollIntoView({ behavior: "smooth" });
            }
          });
        });
      } else {
        container.textContent = "Markdown renderer failed to load.";
      }
    } catch (err) {
      container.innerHTML = `<p class="docs-loading">Could not load <code>${file}</code>. Open from the docs folder with a local server.</p>`;
    }
  }

  function init() {
    initCopyButtons();
    initRecipes();
    initSteps();
    initSearch();
    initPalette();
    initSidebarSpy();
    initMobileNav();
    initViewer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
