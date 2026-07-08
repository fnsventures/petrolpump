const SLIDESHOW_SETS = [
  {
    webp: "assets/landing-01.webp",
    webpNarrow: "assets/landing-01-800.webp",
    jpg: "assets/landing-01.JPG",
  },
  {
    webp: "assets/landing-02.webp",
    webpNarrow: "assets/landing-02-800.webp",
    jpg: "assets/landing-02.JPG",
  },
  {
    webp: "assets/landing-03.webp",
    webpNarrow: "assets/landing-03-800.webp",
    jpg: "assets/landing-03.JPG",
  },
  {
    webp: "assets/landing-04.webp",
    webpNarrow: "assets/landing-04-800.webp",
    jpg: "assets/landing-04.JPG",
  },
];

/** Used when slideshow photos are not deployed (e.g. local dev without image assets). */
const SLIDESHOW_FALLBACK = "assets/logo-104.webp";

const SLIDE_INTERVAL_MS = 2500;
const SLIDE_FADE_MS = 800;

const FOOTER_ICONS = {
  whatsapp:
    "M12 3a9 9 0 0 0-7.74 13.61L3 21l4.52-1.19A9 9 0 1 0 12 3zm0 2a7 7 0 1 1-3.57 13.03l-.3-.18-2.11.56.56-2.06-.2-.32A7 7 0 0 1 12 5zm3.15 9.64c-.17-.08-1-.49-1.16-.54-.16-.06-.27-.08-.39.08-.12.17-.45.54-.55.65-.1.11-.2.12-.37.04-.17-.08-.71-.26-1.35-.82-.5-.45-.83-1-.93-1.17-.1-.17-.01-.27.07-.35.08-.08.17-.2.25-.3.08-.1.11-.17.17-.28.06-.11.03-.21-.01-.3-.04-.08-.39-.94-.53-1.29-.14-.35-.28-.3-.39-.3h-.33c-.11 0-.3.04-.46.21-.16.17-.6.59-.6 1.45 0 .86.62 1.7.7 1.82.08.11 1.22 1.86 2.96 2.61.41.18.73.29.98.37.41.13.79.11 1.08.07.33-.05 1-.41 1.14-.81.14-.4.14-.74.1-.81-.04-.07-.15-.11-.32-.19z",
  facebook:
    "M13.5 9.5V7.6c0-.8.5-1 1.2-1H16V4h-2.2c-2.2 0-3.3 1.3-3.3 3.3v2.2H8.6V12h1.9v6h3v-6H16l.4-2.5h-2.9z",
  instagram:
    "M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm5 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm6.5-.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5z",
  youtube:
    "M21.6 7.2a2.5 2.5 0 0 0-1.76-1.77C18.08 5.2 12 5.2 12 5.2s-6.08 0-7.84.23A2.5 2.5 0 0 0 2.4 7.2 26.3 26.3 0 0 0 2.16 12a26.3 26.3 0 0 0 .24 4.8 2.5 2.5 0 0 0 1.76 1.77C5.92 18.8 12 18.8 12 18.8s6.08 0 7.84-.23a2.5 2.5 0 0 0 1.76-1.77A26.3 26.3 0 0 0 21.84 12a26.3 26.3 0 0 0-.24-4.8zM10 15.5v-7l6 3.5-6 3.5z",
  email:
    "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 1 2-2zm7 7.1L19 8H5l7 4.1zm-7 4.9h14V10l-7 4.1L5 10v7z",
};

const FOOTER_LINKS = [
  {
    href: "https://wa.me/919668913299",
    label: "WhatsApp +91 96689 13299",
    tooltip: "+91 96689 13299",
    icon: "whatsapp",
    external: true,
  },
  {
    href: "https://www.facebook.com/profile.php?id=61590580386875",
    label: "Facebook",
    tooltip: "Bishnupriya Fuels on Facebook",
    icon: "facebook",
    external: true,
  },
  {
    href: "https://www.instagram.com/bishnupriyafuels",
    label: "Instagram",
    tooltip: "@bishnupriyafuels",
    icon: "instagram",
    external: true,
  },
  {
    href: "https://www.youtube.com/@BishnupriyaFuels",
    label: "YouTube",
    tooltip: "@BishnupriyaFuels",
    icon: "youtube",
    external: true,
  },
  {
    href: "mailto:bishnupriyafuels@gmail.com",
    label: "Email bishnupriyafuels@gmail.com",
    tooltip: "bishnupriyafuels@gmail.com",
    icon: "email",
  },
];

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function probeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function prefersNarrowSlides() {
  return window.matchMedia("(max-width: 900px)").matches;
}

async function resolveSlideSrc(set) {
  const narrow = prefersNarrowSlides();
  const candidates = narrow
    ? [set.webpNarrow, set.webp, set.jpg]
    : [set.webp, set.jpg];
  for (const src of candidates) {
    const ok = await probeImage(src);
    if (ok) return ok;
  }
  return null;
}

async function resolveSlideshowImages() {
  const loaded = await Promise.all(SLIDESHOW_SETS.map((set) => resolveSlideSrc(set)));
  const available = loaded.filter(Boolean);
  return available.length > 0 ? available : [SLIDESHOW_FALLBACK];
}

function startRandomSlideshow(imageList) {
  const slides = [
    document.querySelector(".slideshow .slide-a"),
    document.querySelector(".slideshow .slide-b"),
  ];
  if (slides.some((el) => !el) || !imageList.length) return;

  let order = shuffle(imageList);
  let index = 0;
  let active = 0;

  const showSlide = () => {
    const next = order[index];
    const nextSlide = slides[1 - active];
    const currentSlide = slides[active];

    nextSlide.style.backgroundImage = `url("${next}")`;
    nextSlide.classList.add("is-visible");

    window.setTimeout(() => {
      currentSlide.classList.remove("is-visible");
    }, SLIDE_FADE_MS);

    active = 1 - active;
    index += 1;

    if (index >= order.length) {
      order = shuffle(imageList);
      index = 0;
    }
  };

  slides[active].style.backgroundImage = `url("${order[0]}")`;
  slides[active].classList.add("is-visible");
  index = 1;

  window.setInterval(showSlide, SLIDE_INTERVAL_MS);
}

function initAboutPopupA11y() {
  const panel = document.getElementById("about-popup");
  if (!panel) return;
  const sync = () => {
    const open = location.hash === "#about-popup";
    panel.setAttribute("aria-hidden", open ? "false" : "true");
  };
  sync();
  window.addEventListener("hashchange", sync);
}

function createFooterIconLink({ href, label, tooltip, icon, external }) {
  const link = document.createElement("a");
  link.className = "footer-icon-btn";
  link.href = href;
  link.setAttribute("aria-label", label);
  link.dataset.tooltip = tooltip;

  if (external) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", FOOTER_ICONS[icon]);
  svg.append(path);
  link.append(svg);

  return link;
}

function initFooterIcons() {
  const bar = document.querySelector(".footer-icon-bar");
  if (!bar) return;

  bar.replaceChildren(...FOOTER_LINKS.map(createFooterIconLink));
}

document.addEventListener("DOMContentLoaded", async () => {
  initFooterIcons();
  const images = await resolveSlideshowImages();
  startRandomSlideshow(images);
  initAboutPopupA11y();
});
